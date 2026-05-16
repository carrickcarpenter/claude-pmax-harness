// Owner-chat-id gating middleware per docs/architecture.md §17.4 #6.
//
// First line of every Telegram update: ignore messages from anyone who is
// not the configured owner. The bot is single-user by design.

import { logger } from "../lib/logger.js";

export interface UpdateContextLike {
  from?: { id?: number | string };
  chat?: { id?: number | string };
}

export interface AccessGateOptions {
  ownerChatId: string | number;
}

export function isAuthorized(
  ctx: UpdateContextLike,
  ownerChatId: string | number,
): boolean {
  // Compare as strings — Telegram chat IDs are numbers but env-passed
  // versions are strings.
  const ownerStr = String(ownerChatId);
  const fromId = ctx.from?.id !== undefined ? String(ctx.from.id) : null;
  const chatId = ctx.chat?.id !== undefined ? String(ctx.chat.id) : null;
  return fromId === ownerStr || chatId === ownerStr;
}

/**
 * grammY-compatible middleware factory. Drops any update that isn't from the
 * owner. Logs blocked attempts (chat_id only — no message content captured).
 */
export function makeAccessGate(opts: AccessGateOptions) {
  return async (ctx: UpdateContextLike, next: () => Promise<void>): Promise<void> => {
    if (!isAuthorized(ctx, opts.ownerChatId)) {
      logger.warn(
        { chat_id: ctx.chat?.id, from_id: ctx.from?.id },
        "[bot] blocked unauthorized message",
      );
      return; // drop silently
    }
    await next();
  };
}
