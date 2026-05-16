// Telegram file download helper. Given a Bot instance + file_id, downloads
// the file to a temp path and returns it. Used by voice + photo + document
// handlers.

import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { logger } from "../lib/logger.js";

export interface FileApiLike {
  api: {
    getFile(fileId: string): Promise<{ file_path?: string }>;
  };
  token?: string;
}

/**
 * Download a Telegram file to /tmp. Returns the local absolute path.
 * Uses fetch (built-in to Node 20+) to grab the file.
 */
export async function downloadTelegramFile(
  bot: FileApiLike,
  token: string,
  fileId: string,
  ext: string,
): Promise<string> {
  const fileInfo = await bot.api.getFile(fileId);
  if (!fileInfo.file_path) {
    throw new Error(`Telegram getFile returned no file_path for ${fileId}`);
  }
  const url = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Telegram file download failed: ${resp.status} ${resp.statusText}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  const safeExt = ext.startsWith(".") ? ext : `.${ext}`;
  const dest = resolve(tmpdir(), `harness-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${safeExt}`);
  writeFileSync(dest, buf);
  logger.info({ file_id: fileId, dest, bytes: buf.length }, "[file-download] saved");
  return dest;
}

/**
 * Map a Telegram document MIME to a sensible extension for the local file.
 * Defaults to ".bin" for unknown types.
 */
export function extFromMime(mime: string | undefined): string {
  if (!mime) return ".bin";
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  if (mime === "audio/ogg") return ".ogg";
  if (mime === "audio/mp3" || mime === "audio/mpeg") return ".mp3";
  if (mime === "audio/wav") return ".wav";
  return ".bin";
}
