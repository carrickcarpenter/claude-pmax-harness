// Document handler per docs/architecture.md §17.10 #3.
//
// Telegram desktop often sends screenshots as documents (not photos).
// For image-MIME documents: route through the photo flow.
// For non-image documents: polite acknowledgment so nothing silently
// drops.

import { unlinkSync } from "node:fs";
import { logger } from "../../lib/logger.js";
import { downloadTelegramFile, extFromMime, type FileApiLike } from "../file-download.js";
import type { TextContext } from "./text.js";

export interface DocumentContext extends TextContext {
  message?: {
    text?: string;
    caption?: string;
    document?: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
    };
  };
}

export interface DocumentHandlerDeps {
  token: string;
  processAsText: (ctx: DocumentContext, instruction: string) => Promise<void>;
}

export function makeDocumentHandler(deps: DocumentHandlerDeps, bot: FileApiLike) {
  return async (ctx: DocumentContext): Promise<void> => {
    const doc = ctx.message?.document;
    if (!doc?.file_id) return;
    const mime = doc.mime_type ?? "";

    if (!mime.startsWith("image/")) {
      await ctx
        .reply(
          `I got a file (${doc.file_name ?? "unnamed"}, ${mime || "unknown type"}) but I only handle images right now. Tell me what you'd like me to do with it.`,
        )
        .catch(() => {});
      return;
    }

    let tempFile: string | undefined;
    try {
      await ctx.replyWithChatAction("typing").catch(() => {});
      tempFile = await downloadTelegramFile(bot, deps.token, doc.file_id, extFromMime(mime));
      const caption = ctx.message?.caption?.trim() ?? "";
      const instruction = caption
        ? `[The user sent you an image (as a file attachment) with caption: "${caption}". Use your Read tool to view the image at this absolute path: ${tempFile}. Respond about what you see and their caption.]`
        : `[The user sent you an image (as a file attachment) with no caption. Use your Read tool to view it at this absolute path: ${tempFile}. Figure out from the image what they're showing you and respond.]`;
      await deps.processAsText(ctx, instruction);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "[document] handler failed",
      );
      await ctx
        .reply("Had trouble with that file. Try again or send it as a regular photo.")
        .catch(() => {});
    } finally {
      if (tempFile) {
        try {
          unlinkSync(tempFile);
        } catch {
          // ignore
        }
      }
    }
  };
}
