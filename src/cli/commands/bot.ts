// `harness bot` — runs the Telegram bot in the foreground.
// Intended for pm2/systemd to invoke as a long-running process.

import { resolve } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../../config/load.js";
import { ConfigError, EXIT_CODES, UserError } from "../../lib/errors.js";
import { MemPalaceBridge } from "../../memory/bridge.js";
import { startBot } from "../../bot/index.js";
import { logger } from "../../lib/logger.js";

export interface BotCommandOptions {
  projectRoot: string;
}

export async function runBot(opts: BotCommandOptions): Promise<number> {
  let loaded;
  try {
    loaded = loadConfig({ projectRoot: opts.projectRoot });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      return EXIT_CODES.CONFIG_ERROR;
    }
    throw err;
  }
  if (!loaded.config) {
    throw new UserError(
      "personal/config.yaml not found. Run `harness setup` to generate it.",
    );
  }

  const dataDir = loaded.env.HARNESS_DATA_DIR ?? resolve(homedir(), ".claude-pmax-harness");
  const stateDir = resolve(dataDir, "state");
  const personalDir = resolve(opts.projectRoot, "personal");

  const bridge = new MemPalaceBridge({
    dataDir,
  });

  // §17.5 #1 — verify bridge before going live.
  try {
    const ready = await bridge.start();
    logger.info(
      { bridge_version: ready.bridge_version, mempalace_version: ready.mempalace_version },
      "[bot] MemPalace bridge ready",
    );
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[bot] MemPalace bridge failed to start — chat will run without semantic recall",
    );
    // Continue anyway — graceful degradation per §18.3 #4.
  }

  const started = await startBot({
    token: loaded.env.TELEGRAM_BOT_TOKEN,
    ownerChatId: loaded.env.TELEGRAM_OWNER_CHAT_ID,
    config: loaded.config,
    bridge,
    cwd: opts.projectRoot,
    personalDir,
    stateDir,
    cliPath: loaded.env.CLAUDE_CLI ?? loaded.config.claude.binary,
  });

  // §17.7 #1 — catch crashes; let supervisor restart.
  const shutdown = async (reason: string) => {
    logger.info({ reason }, "[bot] shutting down");
    await started.stop();
    bridge.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("uncaughtException", (err) => {
    started.errorLog.appendError("uncaughtException", {
      name: err.name,
      message: err.message,
      stack: err.stack ?? "(no stack)",
    });
    logger.error({ err }, "[bot] uncaughtException — exiting");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    started.errorLog.appendError("unhandledRejection", {
      message,
      stack: reason instanceof Error ? reason.stack ?? "(no stack)" : "(no stack)",
    });
    logger.error({ reason: message }, "[bot] unhandledRejection — exiting");
    process.exit(1);
  });

  // Stay alive until SIGINT/SIGTERM.
  return new Promise<number>(() => {
    // never resolves — bot runs until signal
  });
}
