// Disk error + response logs per docs/architecture.md §17.7 #1/#2/#3.
//
// error.log: append-only crash/error forensics with structured entries.
// response.log: per-turn response summary (prompt head, response head/tail,
// elapsed, flagged-as-error boolean).
//
// Both live in state dir so they survive restarts and the user can inspect
// them from Telegram via /errors and /lastlog slash commands.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { logger } from "../lib/logger.js";

export class ErrorLog {
  readonly errorPath: string;
  readonly responsePath: string;

  constructor(stateDir: string) {
    this.errorPath = resolve(stateDir, "error.log");
    this.responsePath = resolve(stateDir, "response.log");
    mkdirSync(dirname(this.errorPath), { recursive: true });
  }

  /** §17.7 #2 — call once at startup so we know the log is writable. */
  verifyWritable(): void {
    try {
      this.appendError("startup", {
        ts: new Date().toISOString(),
        pid: process.pid,
        msg: "error log writable",
      });
    } catch (err) {
      logger.error({ err, path: this.errorPath }, "[error-log] startup write failed");
      throw err;
    }
  }

  appendError(context: string, details: Record<string, unknown>): void {
    const ts = new Date().toISOString();
    const lines = [
      `\n=== ${ts} — ${context} ===`,
      ...Object.entries(details).map(
        ([k, v]) =>
          `${k}: ${typeof v === "string" ? v : safeStringify(v)}`,
      ),
      "",
    ];
    const text = lines.join("\n") + "\n";
    try {
      appendFileSync(this.errorPath, text);
    } catch (err) {
      logger.error({ err, path: this.errorPath }, "[error-log] write failed");
    }
  }

  appendResponse(entry: {
    timestamp: string;
    elapsed_ms: number;
    prompt_head: string;
    response_head: string;
    response_tail: string;
    response_length: number;
    session_id: string;
    flagged: boolean;
    flag_reason?: string;
  }): void {
    const flag = entry.flagged ? "FLAGGED" : "OK";
    const lines = [
      `\n--- ${entry.timestamp} [${(entry.elapsed_ms / 1000).toFixed(1)}s] ${flag} ---`,
    ];
    if (entry.flagged && entry.flag_reason) {
      lines.push(`flag: ${entry.flag_reason}`);
    }
    lines.push(`prompt: ${entry.prompt_head}`);
    lines.push(`response (${entry.response_length} chars): ${entry.response_head}`);
    if (entry.response_length > 300) {
      lines.push(`...tail: ${entry.response_tail}`);
    }
    lines.push(`session: ${entry.session_id}`);
    lines.push("");
    try {
      appendFileSync(this.responsePath, lines.join("\n") + "\n");
    } catch (err) {
      logger.warn({ err, path: this.responsePath }, "[response-log] write failed");
    }
  }

  /** Read the last N error entries, formatted as a summary string. */
  tailErrors(n: number = 5, maxChars: number = 4000): string {
    if (!existsSync(this.errorPath)) return "(no error log)";
    const raw = readFileSync(this.errorPath, "utf-8");
    const entries = raw.split(/\n=== /).filter(Boolean);
    if (entries.length === 0) return "(error log empty)";
    const recent = entries.slice(-n);
    const summary = `${entries.length} total entries. Last ${recent.length}:\n\n` +
      recent.map((e) => "=== " + e.trim()).join("\n\n");
    return summary.length > maxChars ? "..." + summary.slice(-maxChars) : summary;
  }

  tailResponses(n: number = 5, maxChars: number = 4000): string {
    if (!existsSync(this.responsePath)) return "(no response log)";
    const raw = readFileSync(this.responsePath, "utf-8");
    const entries = raw.split(/\n--- /).filter(Boolean);
    if (entries.length === 0) return "(response log empty)";
    const recent = entries.slice(-n);
    const summary = recent.map((e) => "--- " + e.trim()).join("\n\n");
    return summary.length > maxChars ? "..." + summary.slice(-maxChars) : summary;
  }

  clearErrors(): void {
    try {
      writeFileSync(this.errorPath, "");
    } catch (err) {
      logger.warn({ err }, "[error-log] clear failed");
    }
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
