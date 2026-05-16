// Telegram message helpers per docs/architecture.md §17.4 #4 + #5.
//
// Telegram silently drops messages over 4096 chars — we must chunk.
// Markdown parse_mode often fails on legitimate text (unescaped underscores
// in identifiers, code fences with weird content, etc.) — always fall back
// to no parse_mode on rejection.

export const TELEGRAM_MAX_MESSAGE = 4096;

/**
 * Split a string into Telegram-safe chunks.
 * Tries to break on paragraph boundaries, then line boundaries, then word
 * boundaries before resorting to mid-word splits.
 */
export function splitMessage(text: string, maxLength: number = TELEGRAM_MAX_MESSAGE): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let cutAt = -1;
    const window = remaining.slice(0, maxLength);

    const paragraphIdx = window.lastIndexOf("\n\n");
    if (paragraphIdx > maxLength * 0.5) {
      cutAt = paragraphIdx + 2;
    } else {
      const lineIdx = window.lastIndexOf("\n");
      if (lineIdx > maxLength * 0.5) {
        cutAt = lineIdx + 1;
      } else {
        const wordIdx = window.lastIndexOf(" ");
        if (wordIdx > maxLength * 0.5) {
          cutAt = wordIdx + 1;
        } else {
          cutAt = maxLength;
        }
      }
    }

    chunks.push(remaining.slice(0, cutAt).trimEnd());
    remaining = remaining.slice(cutAt);
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// Minimal grammY-context-compatible interface so handlers can be tested with
// mocks. The real grammY Context satisfies this structurally.
export interface ReplyContext {
  reply(
    text: string,
    options?: { parse_mode?: "Markdown" | "MarkdownV2" | "HTML" },
  ): Promise<unknown>;
}

/**
 * Send a (potentially long) text message via Telegram, chunked safely.
 * Tries parse_mode: "Markdown" first; falls back to plain text if grammY
 * throws a TelegramError (typically MARKDOWN_PARSE failures).
 */
export async function sendChunked(
  ctx: ReplyContext,
  text: string,
  opts: { maxLength?: number; preferMarkdown?: boolean } = {},
): Promise<void> {
  const max = opts.maxLength ?? TELEGRAM_MAX_MESSAGE;
  const preferMarkdown = opts.preferMarkdown ?? true;
  for (const chunk of splitMessage(text, max)) {
    if (preferMarkdown) {
      try {
        await ctx.reply(chunk, { parse_mode: "Markdown" });
        continue;
      } catch {
        // fall through to plain text
      }
    }
    await ctx.reply(chunk);
  }
}
