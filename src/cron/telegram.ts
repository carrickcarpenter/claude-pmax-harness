// Direct Telegram Bot API client for cron-side delivery and alerts.
// Avoids depending on the bot's grammY instance so cron can run as its own
// concern (matches the source codebase's separation of cron from bot even
// though both live in the same Node process under §9(a) LOCKED).

import { logger } from "../lib/logger.js";

export interface TelegramSenderOptions {
  token: string;
  ownerChatId: string;
  /** Max chunk length. Default 4096 (Telegram limit). */
  maxLength?: number;
}

export class TelegramSender {
  constructor(private readonly opts: TelegramSenderOptions) {}

  /**
   * Send a (potentially long) message to the owner.
   * Chunks at the Telegram limit and tries Markdown first, falls back to
   * plain text on rejection. Returns true on at least one successful send.
   */
  async send(text: string): Promise<boolean> {
    const max = this.opts.maxLength ?? 4096;
    const chunks = splitForTelegram(text, max);
    let anySuccess = false;
    for (const chunk of chunks) {
      const ok = await this.sendChunk(chunk, true);
      if (ok) {
        anySuccess = true;
        continue;
      }
      const plainOk = await this.sendChunk(chunk, false);
      if (plainOk) anySuccess = true;
    }
    return anySuccess;
  }

  private async sendChunk(text: string, useMarkdown: boolean): Promise<boolean> {
    const url = `https://api.telegram.org/bot${this.opts.token}/sendMessage`;
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.opts.ownerChatId,
          text,
          ...(useMarkdown ? { parse_mode: "Markdown" } : {}),
        }),
      });
      if (!resp.ok) {
        logger.warn(
          { status: resp.status, markdown: useMarkdown },
          "[cron-telegram] non-ok send",
        );
        return false;
      }
      return true;
    } catch (err) {
      logger.warn({ err }, "[cron-telegram] fetch threw");
      return false;
    }
  }
}

function splitForTelegram(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = remaining.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = remaining.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    out.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) out.push(remaining);
  return out;
}
