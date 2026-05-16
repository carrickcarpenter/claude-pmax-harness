// Disk-persisted conversation buffer per docs/architecture.md §17.6 #3.
//
// Stores the last N exchanges per chat as JSON. Survives service restarts.
// With §10 stateless LOCKED, this is the *primary* thread-continuity
// mechanism — claude itself doesn't carry state across invocations, so
// the harness ships the buffer back into each new turn's prompt.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { logger } from "../lib/logger.js";

export const DEFAULT_MAX_BUFFER_ENTRIES = 8;

export interface BufferEntry {
  user_message: string;
  assistant_response: string;
  timestamp: string;
}

export interface BufferOptions {
  /** Directory where per-chat JSON files live. Created if missing. */
  stateDir: string;
  /** Max entries kept on disk. Excess truncated from the front (oldest). */
  maxEntries?: number;
  /** Truncate user message to this many chars before saving. */
  userMessageMaxChars?: number;
  /** Truncate assistant response to this many chars before saving. */
  assistantResponseMaxChars?: number;
}

export class ConversationBuffer {
  private readonly maxEntries: number;
  private readonly userMax: number;
  private readonly assistantMax: number;

  constructor(private readonly opts: BufferOptions) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_BUFFER_ENTRIES;
    this.userMax = opts.userMessageMaxChars ?? 300;
    this.assistantMax = opts.assistantResponseMaxChars ?? 600;
    mkdirSync(opts.stateDir, { recursive: true });
  }

  private pathFor(chatId: string | number): string {
    // Sanitize chatId so it can't escape stateDir.
    const safe = String(chatId).replace(/[^A-Za-z0-9_-]/g, "_");
    return resolve(this.opts.stateDir, `${safe}.json`);
  }

  load(chatId: string | number): BufferEntry[] {
    const path = this.pathFor(chatId);
    if (!existsSync(path)) return [];
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isValidEntry);
    } catch (err) {
      logger.warn({ err, chat_id: chatId }, "[buffer] failed to read");
      return [];
    }
  }

  append(chatId: string | number, userMessage: string, assistantResponse: string): BufferEntry[] {
    const current = this.load(chatId);
    const entry: BufferEntry = {
      user_message: userMessage.slice(0, this.userMax),
      assistant_response: assistantResponse.slice(0, this.assistantMax),
      timestamp: new Date().toISOString(),
    };
    const next = [...current, entry].slice(-this.maxEntries);
    this.save(chatId, next);
    return next;
  }

  save(chatId: string | number, entries: BufferEntry[]): void {
    const path = this.pathFor(chatId);
    try {
      writeFileSync(path, JSON.stringify(entries, null, 2) + "\n");
    } catch (err) {
      logger.error({ err, chat_id: chatId }, "[buffer] failed to save");
    }
  }

  clear(chatId: string | number): void {
    this.save(chatId, []);
  }

  /**
   * Format the buffer as a prompt-injection markdown section.
   * Returns "" if empty. The caller decides whether to splice in.
   */
  formatForInjection(entries: BufferEntry[]): string {
    if (entries.length === 0) return "";
    const lines = entries
      .map(
        (e) =>
          `User: "${e.user_message}${e.user_message.length >= this.userMax ? "..." : ""}"\nAssistant: "${e.assistant_response}${e.assistant_response.length >= this.assistantMax ? "..." : ""}"`,
      )
      .join("\n\n");
    return [
      `# Recent conversation thread (${entries.length} exchanges)`,
      "",
      "Use this to maintain continuity — the user expects you to remember what you were just discussing.",
      "",
      lines,
    ].join("\n");
  }
}

function isValidEntry(x: unknown): x is BufferEntry {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.user_message === "string" &&
    typeof e.assistant_response === "string" &&
    typeof e.timestamp === "string"
  );
}
