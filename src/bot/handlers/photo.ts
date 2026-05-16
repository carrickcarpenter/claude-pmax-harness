// Photo handler per docs/architecture.md §17.10 #2.
//
// Downloads the largest size variant from Telegram, then routes through
// the text pipeline with an instruction prefix telling Claude to use the
// Read tool on the file path. Claude is multimodal; Read accepts images.

import { unlinkSync } from "node:fs";
import { logger } from "../../lib/logger.js";
import { downloadTelegramFile, type FileApiLike } from "../file-download.js";
import type { TextContext } from "./text.js";

export interface PhotoContext extends TextContext {
  message?: {
    text?: string;
    caption?: string;
    photo?: Array<{
      file_id: string;
      width?: number;
      height?: number;
    }>;
  };
}

export interface PhotoHandlerDeps {
  token: string;
  /** Routes the image-instruction prompt through the text pipeline. */
  processAsText: (ctx: PhotoContext, instruction: string) => Promise<void>;
}

export function makePhotoHandler(deps: PhotoHandlerDeps, bot: FileApiLike) {
  return async (ctx: PhotoContext): Promise<void> => {
    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) return;
    const largest = photos[photos.length - 1]!;
    let tempFile: string | undefined;
    try {
      await ctx.replyWithChatAction("typing").catch(() => {});
      tempFile = await downloadTelegramFile(bot, deps.token, largest.file_id, ".jpg");
      const caption = ctx.message?.caption?.trim() ?? "";
      const instruction = caption
        ? `[The user sent you an image with caption: "${caption}". Use your Read tool to view the image at this absolute path: ${tempFile}. Respond to them about what you see and their caption.]`
        : `[The user sent you an image with no caption. Use your Read tool to view it at this absolute path: ${tempFile}. Figure out from the image what they're showing you and respond.]`;
      await deps.processAsText(ctx, instruction);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "[photo] handler failed",
      );
      await ctx
        .reply("Had trouble with that image. Try again or describe it in text.")
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
