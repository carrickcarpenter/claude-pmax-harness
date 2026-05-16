// Claude CLI wrapper per docs/architecture.md §10 (stateless) + §17.2.
//
// Spawns `claude -p <prompt>` per invocation. Stateless — no --resume.
// Reads stream-json output for progressive text deltas + final result.
// Hard ceiling only (no inactivity watchdog — see §17.2 #2 for why).
// Cleans up stale direct-child claude processes before each call.
// NEVER passes --system-prompt — identity comes from CLAUDE.md
// auto-discovery from cwd. NO_COLOR=1 to keep stream parsing clean.

import { spawn } from "node:child_process";
import { logger } from "../lib/logger.js";
import { ExternalError } from "../lib/errors.js";
import { classifyResponse, type ErrorShapeMatch } from "./error-shapes.js";
import { killStaleClaude } from "./cleanup.js";

export type ClaudeModel = "haiku" | "sonnet" | "opus";

export interface InvokeOptions {
  /** The full prompt string (already assembled with date line, memory, etc.). */
  prompt: string;
  /** Model tier — haiku/sonnet/opus. Default sonnet. */
  model?: ClaudeModel;
  /**
   * Explicit allowed-tools list per §17.2 #7. Empty array = no tools.
   * undefined = use a conservative default (no Bash/Write/Edit).
   */
  allowedTools?: string[];
  /** Hard-ceiling wall-clock timeout. */
  timeoutMs: number;
  /** Working directory for CLAUDE.md auto-discovery. */
  cwd?: string;
  /** Override the claude binary path. Defaults to CLAUDE_CLI env or "claude". */
  cliPath?: string;
  /** Streaming text delta callback. */
  onText?: (delta: string) => void;
  /** Streaming tool-use callback. */
  onToolUse?: (toolName: string) => void;
}

export interface InvokeResult {
  text: string;
  sessionId?: string;
  durationMs: number;
  flagged: ErrorShapeMatch;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  delta?: { type?: string; text?: string };
  content_block?: { type?: string; name?: string };
}

const DEFAULT_ALLOWED_TOOLS_RESTRICTED = ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];
const SIGKILL_GRACE_MS = 5_000;

export async function invokeClaude(opts: InvokeOptions): Promise<InvokeResult> {
  const cliPath = opts.cliPath ?? process.env.CLAUDE_CLI ?? "claude";
  const model = opts.model ?? "sonnet";
  const allowedTools = opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS_RESTRICTED;

  // §17.2 #3 — scoped stale-process cleanup before each new call.
  killStaleClaude();

  const args: string[] = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
  ];
  if (allowedTools.length > 0) {
    args.push("--allowedTools", allowedTools.join(","));
  }
  // §17.2 #5: NEVER pass --system-prompt. Identity comes from CLAUDE.md
  // auto-discovered from cwd. (No code here — explicit absence is the point.)

  const startTime = Date.now();

  return new Promise<InvokeResult>((resolve, reject) => {
    const child = spawn(cliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd,
      env: {
        ...process.env,
        // §17.2 #6: keep stream parsing clean of ANSI escapes.
        NO_COLOR: "1",
        // §17.2 #8: pass HOME explicitly so CLAUDE.md auto-discovery from
        // cwd + the user's claude session storage land in the expected place
        // even if a wrapper script altered HOME upstream. Inheriting from
        // process.env.HOME is the correct default for a single-user harness;
        // making it explicit guards against future env-filtering refactors.
        HOME: process.env.HOME ?? "",
      },
    });

    // Close stdin so the CLI doesn't wait for input.
    child.stdin.end();

    let stderr = "";
    let resultText = "";
    let sessionId: string | undefined;
    let lineBuf = "";
    let settled = false;

    // §17.2 #2: hard ceiling only. NO inactivity watchdog. Tool execution
    // (web search, file ops, transcription) emits zero stream events; silence
    // is indistinguishable from working.
    const hardCeiling = setTimeout(() => {
      if (settled) return;
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, SIGKILL_GRACE_MS).unref();
    }, opts.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: StreamEvent;
        try {
          msg = JSON.parse(line) as StreamEvent;
        } catch {
          continue;
        }
        if (msg.type === "result") {
          if (typeof msg.result === "string") resultText = msg.result;
          if (typeof msg.session_id === "string") sessionId = msg.session_id;
        } else if (
          msg.type === "content_block_delta" &&
          msg.delta?.type === "text_delta" &&
          typeof msg.delta.text === "string"
        ) {
          opts.onText?.(msg.delta.text);
        } else if (
          msg.type === "content_block_start" &&
          msg.content_block?.type === "tool_use" &&
          typeof msg.content_block.name === "string"
        ) {
          opts.onToolUse?.(msg.content_block.name);
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8192) {
        stderr = "...(truncated)..." + stderr.slice(-8192);
      }
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardCeiling);
      const durationMs = Date.now() - startTime;
      const elapsed = (durationMs / 1000).toFixed(1);

      const hitCeiling = durationMs >= opts.timeoutMs - 500;
      if (hitCeiling) {
        logger.warn(
          { elapsed, code, signal, cliPath },
          "[claude] hard ceiling hit",
        );
        reject(new ExternalError(`claude CLI hard ceiling at ${elapsed}s`));
        return;
      }

      // If we got a result string, return it (even if exit code is non-zero —
      // classify might still flag it as an API-error response).
      if (resultText) {
        const flagged = classifyResponse(resultText);
        if (flagged.flagged && flagged.category === "api-error") {
          logger.error(
            { elapsed, reason: flagged.reason },
            "[claude] result IS API error — treating as failure",
          );
          reject(new ExternalError(`API error in claude result: ${flagged.reason}`));
          return;
        }
        resolve({
          text: resultText,
          sessionId,
          durationMs,
          flagged,
        });
        return;
      }

      // No result and exit non-zero: failure.
      logger.error(
        {
          elapsed,
          code,
          signal,
          stderr: stderr.slice(0, 500),
        },
        "[claude] exited without a result",
      );
      reject(
        new ExternalError(
          `claude CLI exited (code=${code} signal=${signal}) with no result after ${elapsed}s`,
        ),
      );
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardCeiling);
      logger.error({ err: err.message, cliPath }, "[claude] spawn error");
      reject(err);
    });
  });
}
