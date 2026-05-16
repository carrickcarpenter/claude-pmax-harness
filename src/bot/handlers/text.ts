// Text message handler — the central orchestrator for chat turns.
//
// Pipeline (per docs/architecture.md §11 + §17 patterns):
//   1. Owner gating happened in middleware — handler trusts authorization.
//   2. Start typing indicator + keep-alive (§17.4 #7).
//   3. Token-compaction check (§17.6 #4) — if session is past threshold,
//      archive buffer to MemPalace and start fresh.
//   4. Load conversation buffer (§17.6 #3) — primary thread continuity
//      under §10 stateless LOCKED.
//   5. Assemble prompt: date line first (§17.1 #1), then user message,
//      then context. Bootstrap only on new session (§17.6 #1).
//   6. Invoke claude via the wrapper (§17.2 patterns) with progressive
//      Telegram message editing per §17.4 #3.
//   7. Classify response — if flagged as soft-apology, retry once.
//   8. Final send chunked + Markdown-with-fallback (§17.4 #4/#5).
//   9. Save exchange to conversation buffer (sync).
//   10. Best-effort sync MemPalace remember (§12 LOCKED).

import type { Config } from "../../config/schema.js";
import type { MemPalaceBridge } from "../../memory/bridge.js";
import { assemblePrompt } from "../../prompt/assemble.js";
import { invokeClaude } from "../../claude/invoke.js";
import { ConversationBuffer } from "../conversation-buffer.js";
import { ErrorLog } from "../error-log.js";
import {
  sendChunked,
  splitMessage,
  TELEGRAM_MAX_MESSAGE,
  type ReplyContext,
} from "../messaging.js";
import { logger } from "../../lib/logger.js";

// Minimal grammY Context interface — only the bits we actually call.
// Keeps the handler testable without depending on grammY's Context type.
export interface TextContext extends ReplyContext {
  chat?: { id: number | string };
  from?: { id: number | string };
  message?: { text?: string };
  replyWithChatAction(action: "typing"): Promise<unknown>;
  /** Used for progressive streaming edits during a turn. */
  api?: {
    editMessageText(
      chatId: number | string,
      messageId: number,
      text: string,
      options?: { parse_mode?: "Markdown" | "MarkdownV2" | "HTML" },
    ): Promise<unknown>;
    deleteMessage(
      chatId: number | string,
      messageId: number,
    ): Promise<unknown>;
  };
  /** Returns the message id of the sent reply (used to track the placeholder). */
  reply(
    text: string,
    options?: { parse_mode?: "Markdown" | "MarkdownV2" | "HTML" },
  ): Promise<{ message_id?: number } | unknown>;
}

export interface TextHandlerDeps {
  config: Config;
  bridge: MemPalaceBridge;
  buffer: ConversationBuffer;
  errorLog: ErrorLog;
  personalDir: string;
  cwd: string;
  cliPath?: string;
  invocationTimeoutMs?: number;
  allowedTools?: string[];
}

/** Per-chat session-token estimate, used for §17.6 #4 proactive compaction. */
const sessionTokens = new Map<string, number>();
/** Default compaction threshold = 60% of 1M Pro Max context window. */
const DEFAULT_COMPACTION_TOKENS = 600_000;
/** Rough char-to-token estimate per the audit notes (~4 chars/token). */
const CHARS_PER_TOKEN = 4;
/** Min delay between progressive edits (Telegram rate limit). */
const STREAM_EDIT_INTERVAL_MS = 3000;
/** Min chars accumulated before we send the first placeholder. */
const STREAM_PLACEHOLDER_MIN_CHARS = 20;

export function makeTextHandler(deps: TextHandlerDeps) {
  return async (ctx: TextContext): Promise<void> => {
    const userMessage = ctx.message?.text;
    if (typeof userMessage !== "string") return;
    await processTextTurn(deps, ctx, userMessage);
  };
}

/**
 * Process a turn given an explicit user message string. Used by both the
 * plain text handler AND the voice/photo/document handlers (which route
 * their transcripts/instructions through this same pipeline).
 */
export async function processTextTurn(
  deps: TextHandlerDeps,
  ctx: TextContext,
  userMessage: string,
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const chatKey = String(chatId);
  const timeoutMs = deps.invocationTimeoutMs ?? 10 * 60 * 1000;
  const compactionThreshold =
    Math.floor(
      ((deps.config.claude.token_compaction_percent ?? 60) / 100) * 1_000_000,
    ) || DEFAULT_COMPACTION_TOKENS;

  let typingTimer: NodeJS.Timeout | null = null;
  let streamEditTimer: NodeJS.Timeout | null = null;

  try {
    await ctx.replyWithChatAction("typing").catch(() => {});
    typingTimer = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4000);

    const turnStart = Date.now();

    // §17.6 #4 — proactive token compaction. If we're past threshold,
    // archive the buffer to MemPalace and reset.
    const currentTokens = sessionTokens.get(chatKey) ?? 0;
    if (currentTokens >= compactionThreshold) {
      logger.info(
        { chat: chatKey, tokens: currentTokens, threshold: compactionThreshold },
        "[bot] proactive compaction triggered",
      );
      const buf = deps.buffer.load(chatId);
      if (buf.length > 0) {
        const archival = buf
          .map((e) => `User: ${e.user_message}\nAssistant: ${e.assistant_response}`)
          .join("\n---\n");
        try {
          await deps.bridge.request("remember", {
            chat_id: chatKey,
            user_message: `[Session compacted at ~${currentTokens} tokens — ${buf.length} exchanges archived.]`,
            assistant_response: archival,
            timestamp: new Date().toISOString(),
            kind: "compaction",
          });
        } catch (err) {
          logger.warn({ err }, "[bot] compaction archive to MemPalace failed (non-fatal)");
        }
      }
      deps.buffer.clear(chatId);
      sessionTokens.delete(chatKey);
    }

    const existingBuffer = deps.buffer.load(chatId);
    const isNewSession = existingBuffer.length === 0;
    const bufferBlock = deps.buffer.formatForInjection(existingBuffer);

    const prompt = await assemblePrompt({
      userMessage,
      config: deps.config,
      isNewSession,
      bridge: deps.bridge,
      personalDir: deps.personalDir,
      chatId: chatKey,
      conversationBuffer: bufferBlock,
      wikiIndexPrePass: { cliPath: deps.cliPath, timeoutMs: 30_000 },
    });

    // §17.4 #3 — progressive Telegram editing.
    let progressMsgId: number | undefined;
    let textBuffer = "";
    let lastEditedAt = 0;
    let lastEditedText = "";
    const stopProgressEdits = (): void => {
      if (streamEditTimer) {
        clearInterval(streamEditTimer);
        streamEditTimer = null;
      }
    };
    streamEditTimer = setInterval(() => {
      if (
        !progressMsgId ||
        !ctx.api ||
        !textBuffer ||
        textBuffer === lastEditedText ||
        Date.now() - lastEditedAt < STREAM_EDIT_INTERVAL_MS
      ) {
        return;
      }
      const preview =
        textBuffer.length > TELEGRAM_MAX_MESSAGE - 100
          ? "..." + textBuffer.slice(-(TELEGRAM_MAX_MESSAGE - 100))
          : textBuffer + " ...";
      void ctx.api
        .editMessageText(chatId, progressMsgId, preview)
        .then(() => {
          lastEditedAt = Date.now();
          lastEditedText = textBuffer;
        })
        .catch(() => {
          // editMessageText can reject for legitimate reasons (rate limit,
          // identical content, etc.) — ignore and try again next tick.
        });
    }, STREAM_EDIT_INTERVAL_MS);

    const onTextDelta = (delta: string): void => {
      textBuffer += delta;
      if (!progressMsgId && textBuffer.length >= STREAM_PLACEHOLDER_MIN_CHARS) {
        const preview =
          textBuffer.length > TELEGRAM_MAX_MESSAGE - 100
            ? "..." + textBuffer.slice(-(TELEGRAM_MAX_MESSAGE - 100))
            : textBuffer + " ...";
        void ctx
          .reply(preview)
          .then((sent) => {
            if (
              sent &&
              typeof (sent as { message_id?: number }).message_id === "number"
            ) {
              progressMsgId = (sent as { message_id: number }).message_id;
              lastEditedAt = Date.now();
              lastEditedText = textBuffer;
            }
          })
          .catch(() => {
            // can't send placeholder — fall back to final-only reply
          });
      }
    };

    let result = await invokeClaude({
      prompt,
      cliPath: deps.cliPath,
      cwd: deps.cwd,
      timeoutMs,
      allowedTools: deps.allowedTools,
      onText: onTextDelta,
    });

    if (result.flagged.flagged) {
      logger.warn(
        { reason: result.flagged.reason },
        "[bot] flagged response on first attempt; retrying once",
      );
      // Clear progress state for the retry.
      stopProgressEdits();
      if (progressMsgId && ctx.api) {
        try {
          await ctx.api.deleteMessage(chatId, progressMsgId);
        } catch {
          // ignore
        }
        progressMsgId = undefined;
      }
      textBuffer = "";
      result = await invokeClaude({
        prompt,
        cliPath: deps.cliPath,
        cwd: deps.cwd,
        timeoutMs,
        allowedTools: deps.allowedTools,
        onText: onTextDelta,
      });
      if (result.flagged.flagged) {
        stopProgressEdits();
        await sendChunked(
          ctx,
          "I keep hitting an error on that one. Try again in a minute, or send /clear to reset.",
          { preferMarkdown: false },
        );
        deps.errorLog.appendError("flagged-retry-exhausted", {
          chat_id: chatKey,
          reason: result.flagged.reason,
        });
        return;
      }
    }

    stopProgressEdits();

    const text = result.text.trim() || "(no response)";

    // Final send: prefer to edit the progress message if it fits in one
    // chunk; otherwise delete progress + send chunked.
    if (progressMsgId && ctx.api && text.length <= TELEGRAM_MAX_MESSAGE) {
      try {
        await ctx.api.editMessageText(chatId, progressMsgId, text, {
          parse_mode: "Markdown",
        });
      } catch {
        try {
          await ctx.api.editMessageText(chatId, progressMsgId, text);
        } catch {
          // Edit failed — fall through to a regular reply
          await sendChunked(ctx, text);
        }
      }
    } else {
      if (progressMsgId && ctx.api) {
        try {
          await ctx.api.deleteMessage(chatId, progressMsgId);
        } catch {
          // ignore
        }
      }
      const chunks = splitMessage(text);
      for (const chunk of chunks) {
        try {
          await ctx.reply(chunk, { parse_mode: "Markdown" });
        } catch {
          await ctx.reply(chunk).catch(() => {});
        }
      }
    }

    deps.buffer.append(chatId, userMessage, text);

    // §17.6 #4 — accumulate the session-token estimate.
    const estimatedTurnTokens = Math.ceil(
      (userMessage.length + text.length + (prompt.length - userMessage.length)) /
        CHARS_PER_TOKEN,
    );
    sessionTokens.set(chatKey, (sessionTokens.get(chatKey) ?? 0) + estimatedTurnTokens);

    try {
      const resp = await deps.bridge.request("remember", {
        chat_id: chatKey,
        user_message: userMessage,
        assistant_response: text,
        timestamp: new Date().toISOString(),
      });
      if (!resp.ok && resp.code !== "UNIMPLEMENTED") {
        logger.warn(
          { code: resp.code, error: resp.error },
          "[bot] MemPalace remember failed",
        );
      }
    } catch (err) {
      logger.warn({ err }, "[bot] MemPalace remember threw");
    }

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
    if (streamEditTimer) clearInterval(streamEditTimer);
  }
}

/** Test hook — reset per-chat token tracking. */
export function _resetSessionTokens(): void {
  sessionTokens.clear();
}
