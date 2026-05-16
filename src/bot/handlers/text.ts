// Text message handler — the central orchestrator for chat turns.
//
// Pipeline (per docs/architecture.md §11 + §17 patterns):
//   1. Owner gating happened in middleware — handler trusts authorization.
//   2. Start typing indicator + keep-alive (§17.4 #7).
//   3. Load conversation buffer (§17.6 #3) — primary thread continuity
//      under §10 stateless LOCKED.
//   4. Assemble prompt: date line first (§17.1 #1), then user message,
//      then context (buffer + MemPalace recent + semantic + bootstrap).
//      Bootstrap only on new session (§17.6 #1). Wiki-index pre-pass if
//      enabled (§11a LOCKED).
//   5. Invoke claude via the wrapper (§17.2 patterns).
//   6. Classify response — if flagged as soft-apology, retry once;
//      if flagged as api-error, the wrapper already rejected.
//   7. Send response chunked + Markdown-with-fallback (§17.4 #4/#5).
//   8. Save exchange to conversation buffer (sync) + log per-turn (§17.7 #3).
//   9. Best-effort sync store in MemPalace (§12 LOCKED sync writes; bridge
//      "remember" op returns UNIMPLEMENTED in current build, so this is
//      currently a no-op but the wiring is in place).

import type { Config } from "../../config/schema.js";
import type { MemPalaceBridge } from "../../memory/bridge.js";
import { assemblePrompt } from "../../prompt/assemble.js";
import { invokeClaude } from "../../claude/invoke.js";
import { ConversationBuffer } from "../conversation-buffer.js";
import { ErrorLog } from "../error-log.js";
import { sendChunked, type ReplyContext } from "../messaging.js";
import { logger } from "../../lib/logger.js";

// Minimal grammY Context interface — only the bits we actually call.
// Keeps the handler testable without depending on grammY's Context type.
export interface TextContext extends ReplyContext {
  chat?: { id: number | string };
  from?: { id: number | string };
  message?: { text?: string };
  replyWithChatAction(action: "typing"): Promise<unknown>;
}

export interface TextHandlerDeps {
  config: Config;
  bridge: MemPalaceBridge;
  buffer: ConversationBuffer;
  errorLog: ErrorLog;
  personalDir: string;
  cwd: string;
  /** Optional override for the claude binary (default: env CLAUDE_CLI or "claude"). */
  cliPath?: string;
  /** Hard-ceiling timeout per invocation. Default 10 min. */
  invocationTimeoutMs?: number;
  /** Allowed tools for chat. Default: restricted (no Bash/Write/Edit). */
  allowedTools?: string[];
}

export function makeTextHandler(deps: TextHandlerDeps) {
  const timeoutMs = deps.invocationTimeoutMs ?? 10 * 60 * 1000;

  return async (ctx: TextContext): Promise<void> => {
    const chatId = ctx.chat?.id;
    const userMessage = ctx.message?.text;
    if (chatId === undefined || typeof userMessage !== "string") return;

    let typingTimer: NodeJS.Timeout | null = null;
    try {
      await ctx.replyWithChatAction("typing").catch(() => {});
      // §17.4 #7 — keep typing indicator alive every 4s
      typingTimer = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 4000);

      const turnStart = Date.now();

      // §17.6 #3 — disk-persisted conversation buffer
      const existingBuffer = deps.buffer.load(chatId);
      const isNewSession = existingBuffer.length === 0;
      const bufferBlock = deps.buffer.formatForInjection(existingBuffer);

      const prompt = await assemblePrompt({
        userMessage,
        config: deps.config,
        isNewSession,
        bridge: deps.bridge,
        personalDir: deps.personalDir,
        chatId: String(chatId),
        conversationBuffer: bufferBlock,
        wikiIndexPrePass: {
          cliPath: deps.cliPath,
          timeoutMs: 30_000,
        },
      });

      let result = await invokeClaude({
        prompt,
        cliPath: deps.cliPath,
        cwd: deps.cwd,
        timeoutMs,
        allowedTools: deps.allowedTools,
      });

      // §17.2 #4 — if the wrapper marked the response as a soft apology
      // (not a hard API error — those already rejected), retry once.
      if (result.flagged.flagged) {
        logger.warn(
          { reason: result.flagged.reason },
          "[bot] flagged response on first attempt; retrying once",
        );
        result = await invokeClaude({
          prompt,
          cliPath: deps.cliPath,
          cwd: deps.cwd,
          timeoutMs,
          allowedTools: deps.allowedTools,
        });
        if (result.flagged.flagged) {
          await sendChunked(
            ctx,
            "I keep hitting an error on that one. Try again in a minute, or send /clear to reset.",
            { preferMarkdown: false },
          );
          deps.errorLog.appendError("flagged-retry-exhausted", {
            chat_id: chatId,
            reason: result.flagged.reason,
            response_head: result.text.slice(0, 300),
          });
          return;
        }
      }

      const text = result.text.trim() || "(no response)";
      await sendChunked(ctx, text);

      // §17.6 #3 — append the exchange to disk
      deps.buffer.append(chatId, userMessage, text);

      // §12 LOCKED sync MemPalace write. Bridge currently returns
      // UNIMPLEMENTED; logged but doesn't block the user reply.
      await tryRememberInMemPalace(deps.bridge, {
        chat_id: String(chatId),
        user_message: userMessage,
        assistant_response: text,
        timestamp: new Date().toISOString(),
      });

      // §17.7 #3 — per-turn response log
      const elapsedMs = Date.now() - turnStart;
      deps.errorLog.appendResponse({
        timestamp: new Date().toISOString(),
        elapsed_ms: elapsedMs,
        prompt_head: userMessage.slice(0, 200),
        response_head: text.slice(0, 300),
        response_tail: text.slice(-200),
        response_length: text.length,
        session_id: result.sessionId ?? "(none)",
        flagged: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.errorLog.appendError("text-handler", {
        chat_id: chatId,
        error: message,
        user_message_head: userMessage.slice(0, 200),
      });
      logger.error({ err: message }, "[bot] text handler failed");
      await sendChunked(
        ctx,
        "Sorry, hit an error. Try again, or send /clear to reset.",
        { preferMarkdown: false },
      ).catch(() => {});
    } finally {
      if (typingTimer) clearInterval(typingTimer);
    }
  };
}

async function tryRememberInMemPalace(
  bridge: MemPalaceBridge,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const resp = await bridge.request("remember", payload);
    if (!resp.ok && resp.code !== "UNIMPLEMENTED") {
      logger.warn(
        { code: resp.code, error: resp.error },
        "[bot] MemPalace remember failed",
      );
    }
  } catch (err) {
    logger.warn({ err }, "[bot] MemPalace remember threw");
  }
}
