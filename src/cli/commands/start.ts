// `harness start` — single-process orchestrator per §9(a) LOCKED.
//
// Spawns the MemPalace bridge (verifies handshake), starts the Telegram bot
// with the bridge wired in, starts the cron scheduler with the same bridge
// and optional Google gmail-checker, and hooks shared SIGINT/SIGTERM shutdown.
// This is what pm2/systemd invoke as the long-running process.

import { resolve } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../../config/load.js";
import { ConfigError, EXIT_CODES, UserError } from "../../lib/errors.js";
import { MemPalaceBridge } from "../../memory/bridge.js";
import { startBot } from "../../bot/index.js";
import { startScheduler } from "../../cron/scheduler.js";
import { loadCronJobs } from "../../cron/loader.js";
import { CronJournal } from "../../cron/journal.js";
import { TelegramSender } from "../../cron/telegram.js";
import {
  credentialsFromEnv,
  makeOAuth2Client,
} from "../../adapters/google/client.js";
import { wasSubjectSentRecently } from "../../adapters/google/gmail.js";
import type { CronJob } from "../../cron/types.js";
import { logger } from "../../lib/logger.js";

export interface StartCommandOptions {
  projectRoot: string;
}

export async function runStart(opts: StartCommandOptions): Promise<number> {
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

  const dataDir =
    loaded.env.HARNESS_DATA_DIR ?? resolve(homedir(), ".claude-pmax-harness");
  const stateDir = resolve(dataDir, "state");
  const personalDir = resolve(opts.projectRoot, "personal");
  const cronDir = resolve(personalDir, "cron");

  // 1. MemPalace bridge — startup ping per §17.5 #1
  const bridge = new MemPalaceBridge({ dataDir });
  try {
    const ready = await bridge.start();
    logger.info(
      {
        bridge_version: ready.bridge_version,
        mempalace_version: ready.mempalace_version,
        python: ready.python,
      },
      "[start] MemPalace bridge ready",
    );
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[start] MemPalace bridge failed to start — chat/cron will run without semantic recall",
    );
    // Graceful degradation per §18.3 #4 — continue without bridge.
  }

  // 2. Bot
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

  // 3. Cron scheduler
  const { jobs, errors } = loadCronJobs({
    cronDir,
    defaultTimezone: loaded.config.owner.timezone,
  });
  for (const e of errors) {
    logger.warn({ path: e.path, reason: e.reason }, "[start] skipped invalid cron job");
  }
  const journal = new CronJournal(stateDir);
  const telegram = new TelegramSender({
    token: loaded.env.TELEGRAM_BOT_TOKEN,
    ownerChatId: loaded.env.TELEGRAM_OWNER_CHAT_ID,
  });
  const gmailChecker = makeGmailChecker(loaded.config.google.enabled);
  const sched = startScheduler({
    config: loaded.config,
    jobs,
    journal,
    telegram,
    stateDir,
    cwd: opts.projectRoot,
    cliPath: loaded.env.CLAUDE_CLI ?? loaded.config.claude.binary,
    gmailChecker,
  });
  logger.info(
    { enabled_jobs: jobs.filter((j) => j.enabled).length },
    "[start] cron scheduler started",
  );

  // 4. Shared shutdown
  const shutdown = async (reason: string): Promise<void> => {
    logger.info({ reason }, "[start] shutting down");
    try {
      sched.stop();
      await started.stop();
      bridge.close();
    } catch (err) {
      logger.warn({ err }, "[start] shutdown threw");
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // 5. Crash handlers per §17.7 #1
  process.on("uncaughtException", (err) => {
    started.errorLog.appendError("uncaughtException", {
      name: err.name,
      message: err.message,
      stack: err.stack ?? "(no stack)",
    });
    logger.error({ err }, "[start] uncaughtException — exiting");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    started.errorLog.appendError("unhandledRejection", {
      message,
      stack: reason instanceof Error ? reason.stack ?? "(no stack)" : "(no stack)",
    });
    logger.error({ reason: message }, "[start] unhandledRejection — exiting");
    process.exit(1);
  });

  return new Promise<number>(() => {
    // runs until signal
  });
}

function makeGmailChecker(
  googleEnabled: boolean,
): ((job: CronJob, scheduledFor: Date) => Promise<boolean>) | undefined {
  if (!googleEnabled) return undefined;
  const creds = credentialsFromEnv(process.env);
  if (!creds) {
    logger.warn(
      "[start] google.enabled=true but GOOGLE_* env vars missing — gmail-check disabled",
    );
    return undefined;
  }
  const client = makeOAuth2Client(creds);
  return async (job) => {
    if (!job.gmail_subject) return false;
    try {
      return await wasSubjectSentRecently(client, job.gmail_subject, 1);
    } catch {
      return false;
    }
  };
}
