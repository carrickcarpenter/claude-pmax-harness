// Voice message handler per docs/architecture.md §17.10 #1.
//
// Downloads the .ogg from Telegram, calls scripts/transcribe.sh
// (opt-in faster-whisper venv), echoes the transcript with a mic prefix,
// then routes the transcript through the text handler pipeline.

import { execFileSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../../lib/logger.js";
import { downloadTelegramFile, type FileApiLike } from "../file-download.js";
import type { TextContext } from "./text.js";

export interface VoiceContext extends TextContext {
  message?: {
    text?: string;
    voice?: {
      file_id: string;
      duration?: number;
      mime_type?: string;
    };
  };
}

export interface VoiceHandlerDeps {
  token: string;
  projectRoot: string;
  /** Routes the transcribed text through the normal text-message pipeline. */
  processAsText: (ctx: VoiceContext, transcript: string) => Promise<void>;
  /** Path to transcribe.sh; defaults to scripts/transcribe.sh under projectRoot. */
  transcribeScript?: string;
  /** Override execFile for tests. */
  execShell?: (cmd: string, args: string[]) => string;
}

export function makeVoiceHandler(deps: VoiceHandlerDeps, bot: FileApiLike) {
  const scriptPath =
    deps.transcribeScript ?? resolve(deps.projectRoot, "scripts", "transcribe.sh");
  const exec = deps.execShell ?? ((cmd, args) =>
    execFileSync(cmd, args, { encoding: "utf-8", timeout: 5 * 60 * 1000 }));

  return async (ctx: VoiceContext): Promise<void> => {
    const voice = ctx.message?.voice;
    if (!voice?.file_id) return;

    let tempFile: string | undefined;
    try {
      await ctx.replyWithChatAction("typing").catch(() => {});
      tempFile = await downloadTelegramFile(bot, deps.token, voice.file_id, ".ogg");
      let transcript: string;
      try {
        transcript = exec(scriptPath, [tempFile]).trim();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err: message }, "[voice] transcribe failed");
        await ctx
          .reply(
            "I couldn't transcribe that. If you haven't yet, run `scripts/install-transcribe.sh` to enable voice. Or send it as text.",
          )
          .catch(() => {});
        return;
      }
      if (!transcript) {
        await ctx
          .reply("I couldn't make out what you said. Try again or send it as text.")
          .catch(() => {});
        return;
      }

      // Echo the transcript so the user can confirm we heard right.
      await ctx
        .reply(`mic: _${transcript}_`, { parse_mode: "Markdown" })
        .catch(() => ctx.reply(`mic: ${transcript}`).catch(() => {}));

      // Route through the text pipeline.
      await deps.processAsText(ctx, transcript);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "[voice] handler failed",
      );
      await ctx
        .reply("Had trouble with that voice note. Try again or send as text.")
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
