// Bot factory — wires grammY together with handlers, middleware, and the
// resilience patterns from §17.4. Returns a started Bot. Caller is
// responsible for any process-level shutdown handling.

import { Bot, type Context, GrammyError, HttpError } from "grammy";
import type { Config } from "../config/schema.js";
import type { MemPalaceBridge } from "../memory/bridge.js";
import { ConversationBuffer } from "./conversation-buffer.js";
import { ErrorLog } from "./error-log.js";
import { BotWatchdog } from "./watchdog.js";
import { makeAccessGate } from "./access.js";
import { makeTextHandler } from "./handlers/text.js";
import { logger } from "../lib/logger.js";

export interface StartBotOptions {
  token: string;
  ownerChatId: string;
  config: Config;
  bridge: MemPalaceBridge;
  cwd: string;
  personalDir: string;
  stateDir: string;
  cliPath?: string;
}

export interface StartedBot {
  bot: Bot;
  watchdog: BotWatchdog;
  errorLog: ErrorLog;
  buffer: ConversationBuffer;
  stop(): Promise<void>;
}

export async function startBot(opts: StartBotOptions): Promise<StartedBot> {
  const errorLog = new ErrorLog(opts.stateDir);
  errorLog.verifyWritable(); // §17.7 #2

  const buffer = new ConversationBuffer({
    stateDir: `${opts.stateDir}/sessions`,
  });

  const bot = new Bot(opts.token);

  // §17.4 #6 — owner gating, first line of every update.
  bot.use(makeAccessGate({ ownerChatId: opts.ownerChatId }));

  // §17.4 #8 — slash commands for self-diagnostics.
  registerSlashCommands(bot, buffer, errorLog);

  // Main text handler — the orchestrator.
  const textHandler = makeTextHandler({
    config: opts.config,
    bridge: opts.bridge,
    buffer,
    errorLog,
    personalDir: opts.personalDir,
    cwd: opts.cwd,
    cliPath: opts.cliPath,
    allowedTools: opts.config.tools.allow_dangerous
      ? ["WebSearch", "WebFetch", "Bash", "Read", "Write", "Edit", "Glob", "Grep"]
      : ["WebSearch", "WebFetch", "Read", "Glob", "Grep"],
  });
  bot.on("message:text", textHandler);

  // Catch-all error handler for grammY's internal middleware errors.
  bot.catch((err) => {
    const e = err.error;
    const ctx = err.ctx;
    if (e instanceof GrammyError) {
      errorLog.appendError("grammy-error", {
        code: e.error_code,
        description: e.description,
        update: ctx.update?.update_id,
      });
    } else if (e instanceof HttpError) {
      errorLog.appendError("grammy-http", {
        message: e.message,
        update: ctx.update?.update_id,
      });
    } else {
      errorLog.appendError("grammy-unknown", {
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // §17.4 #2 — polling loop rejection exits the process so the supervisor
  // restarts on a fresh polling connection. grammY does not recover from
  // 409 Conflict or sustained network failures on its own.
  bot
    .start({
      onStart: (info) => {
        logger.info(
          { username: info.username, owner_chat_id: opts.ownerChatId },
          "[bot] online",
        );
      },
    })
    .catch((err) => {
      errorLog.appendError("polling-died", {
        message: err instanceof Error ? err.message : String(err),
      });
      logger.error({ err }, "[bot] polling loop died — exiting for supervisor restart");
      process.exit(1);
    });

  // §17.4 #1 — wedge watchdog
  const watchdog = new BotWatchdog(bot.api, {
    intervalMs: opts.config.bot.watchdog.interval_ms,
    maxFailures: opts.config.bot.watchdog.max_failures,
    onWedged: (failures, lastError) => {
      errorLog.appendError("watchdog-exit", {
        failures,
        last_error: lastError,
        note: "Telegram API unreachable beyond max_failures; exiting for supervisor restart",
      });
    },
  });
  watchdog.start();

  return {
    bot,
    watchdog,
    errorLog,
    buffer,
    async stop() {
      watchdog.stop();
      await bot.stop();
    },
  };
}

function registerSlashCommands(
  bot: Bot,
  buffer: ConversationBuffer,
  errorLog: ErrorLog,
): void {
  bot.command("start", async (ctx: Context) => {
    if (ctx.chat) buffer.clear(ctx.chat.id);
    await ctx.reply(
      "Hello. I'm online — send me a message and I'll help you out. Slash commands: /clear (reset conversation), /errors (recent error log), /lastlog (recent response log).",
    );
  });

  bot.command("clear", async (ctx: Context) => {
    if (ctx.chat) buffer.clear(ctx.chat.id);
    await ctx.reply("Conversation cleared. Starting fresh.");
  });

  bot.command("errors", async (ctx: Context) => {
    const tail = errorLog.tailErrors(5);
    await ctx.reply(tail);
  });

  bot.command("lastlog", async (ctx: Context) => {
    const tail = errorLog.tailResponses(5);
    await ctx.reply(tail);
  });

  bot.command("clearerrors", async (ctx: Context) => {
    errorLog.clearErrors();
    await ctx.reply("Error log cleared.");
  });
}
