// `harness cron` subcommands per docs/architecture.md §3.
//
//   harness cron            run the scheduler in foreground (pm2/systemd)
//   harness cron list       list discovered jobs + their schedules
//   harness cron run <id>   fire a single job immediately, bypass schedule
//   harness cron status     show recent journal entries
//   harness cron next [-n]  show next N fire times across all jobs

import { resolve } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../../config/load.js";
import { ConfigError, EXIT_CODES, UserError } from "../../lib/errors.js";
import { loadCronJobs } from "../../cron/loader.js";
import { CronJournal } from "../../cron/journal.js";
import { TelegramSender } from "../../cron/telegram.js";
import { startScheduler } from "../../cron/scheduler.js";
import { executeJob } from "../../cron/runner.js";
import { nextFireTimes } from "../../cron/schedule.js";
import { credentialsFromEnv, makeOAuth2Client } from "../../adapters/google/client.js";
import { wasSubjectSentRecently } from "../../adapters/google/gmail.js";
import type { CronJob } from "../../cron/types.js";
import { logger } from "../../lib/logger.js";

export interface CronCommandOptions {
  projectRoot: string;
}

interface ResolvedContext {
  projectRoot: string;
  personalDir: string;
  cronDir: string;
  stateDir: string;
  defaultTimezone: string;
  telegramToken: string;
  ownerChatId: string;
  cliPath: string;
  catchupTime: string;
  config: NonNullable<
    Awaited<ReturnType<typeof loadAndCheck>>["loaded"]["config"]
  >;
}

async function resolveContext(opts: CronCommandOptions): Promise<ResolvedContext> {
  const { loaded, dataDir } = await loadAndCheck(opts);
  return {
    projectRoot: opts.projectRoot,
    personalDir: resolve(opts.projectRoot, "personal"),
    cronDir: resolve(opts.projectRoot, "personal", "cron"),
    stateDir: resolve(dataDir, "state"),
    defaultTimezone: loaded.config.owner.timezone,
    telegramToken: loaded.env.TELEGRAM_BOT_TOKEN,
    ownerChatId: loaded.env.TELEGRAM_OWNER_CHAT_ID,
    cliPath: loaded.env.CLAUDE_CLI ?? loaded.config.claude.binary,
    catchupTime: loaded.config.cron.catchup_time,
    config: loaded.config,
  };
}

async function loadAndCheck(opts: CronCommandOptions) {
  let loaded;
  try {
    loaded = loadConfig({ projectRoot: opts.projectRoot });
  } catch (err) {
    if (err instanceof ConfigError) {
      throw err;
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
  return { loaded: { ...loaded, config: loaded.config }, dataDir };
}

export async function runCronList(opts: CronCommandOptions): Promise<number> {
  const ctx = await resolveContext(opts);
  const { jobs, errors } = loadCronJobs({
    cronDir: ctx.cronDir,
    defaultTimezone: ctx.defaultTimezone,
  });
  if (jobs.length === 0 && errors.length === 0) {
    console.log(`No cron jobs found in ${ctx.cronDir}`);
    return EXIT_CODES.SUCCESS;
  }
  console.log(`Loaded ${jobs.length} job(s) from ${ctx.cronDir}:`);
  for (const j of jobs) {
    const enabledTag = j.enabled ? "" : "  [DISABLED]";
    console.log(
      `  ${j.id}${enabledTag}  schedule=${JSON.stringify(j.schedule)}  model=${j.model}  delivery=${j.delivery}`,
    );
  }
  if (errors.length > 0) {
    console.log(`\n${errors.length} error(s):`);
    for (const e of errors) {
      console.log(`  ${e.path}: ${e.reason}`);
    }
    return EXIT_CODES.CONFIG_ERROR;
  }
  return EXIT_CODES.SUCCESS;
}

export async function runCronRun(
  opts: CronCommandOptions & { jobId: string },
): Promise<number> {
  const ctx = await resolveContext(opts);
  const { jobs, errors } = loadCronJobs({
    cronDir: ctx.cronDir,
    defaultTimezone: ctx.defaultTimezone,
  });
  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`  ${e.path}: ${e.reason}`);
    }
  }
  const job = jobs.find((j) => j.id === opts.jobId);
  if (!job) {
    console.error(`No job with id "${opts.jobId}". Available: ${jobs.map((j) => j.id).join(", ") || "(none)"}`);
    return EXIT_CODES.USER_ERROR;
  }
  const journal = new CronJournal(ctx.stateDir);
  const telegram = new TelegramSender({
    token: ctx.telegramToken,
    ownerChatId: ctx.ownerChatId,
  });

  const result = await executeJob({
    job,
    scheduledFor: new Date(),
    cwd: ctx.projectRoot,
    cliPath: ctx.cliPath,
    journal,
    telegram,
    maxAttempts: ctx.config.cron.retry.max_attempts,
    retryDelayMs: ctx.config.cron.retry.backoff_seconds * 1000,
  });

  if (result.success) {
    console.log(`OK — ${job.id} completed in ${result.attempts} attempt(s).`);
    return EXIT_CODES.SUCCESS;
  }
  console.error(`FAIL — ${job.id}: ${result.error}`);
  return EXIT_CODES.EXTERNAL_ERROR;
}

export async function runCronStatus(opts: CronCommandOptions): Promise<number> {
  const ctx = await resolveContext(opts);
  const journal = new CronJournal(ctx.stateDir);
  const entries = journal.tail(20);
  if (entries.length === 0) {
    console.log("(no journal entries)");
    return EXIT_CODES.SUCCESS;
  }
  console.log(`Last ${entries.length} journal entries:`);
  for (const e of entries) {
    const dur = e.duration_ms ? `${(e.duration_ms / 1000).toFixed(1)}s` : "-";
    const err = e.error ? ` error="${e.error.slice(0, 80)}"` : "";
    console.log(
      `  ${e.started_at}  ${e.job_id}  attempt=${e.attempt}  status=${e.status}  dur=${dur}${err}`,
    );
  }
  return EXIT_CODES.SUCCESS;
}

export async function runCronNext(
  opts: CronCommandOptions & { n: number },
): Promise<number> {
  const ctx = await resolveContext(opts);
  const { jobs } = loadCronJobs({
    cronDir: ctx.cronDir,
    defaultTimezone: ctx.defaultTimezone,
  });
  if (jobs.length === 0) {
    console.log("(no jobs loaded)");
    return EXIT_CODES.SUCCESS;
  }
  const now = new Date();
  const upcoming: Array<{ time: Date; jobId: string }> = [];
  for (const job of jobs) {
    if (!job.enabled) continue;
    const tz = job.timezone ?? ctx.defaultTimezone;
    const fires = nextFireTimes(job.schedule, opts.n, now, tz);
    for (const t of fires) upcoming.push({ time: t, jobId: job.id });
  }
  upcoming.sort((a, b) => a.time.getTime() - b.time.getTime());
  const limited = upcoming.slice(0, opts.n);
  console.log(`Next ${limited.length} fire times (across ${jobs.length} jobs):`);
  for (const u of limited) {
    console.log(`  ${u.time.toISOString()}  ${u.jobId}`);
  }
  return EXIT_CODES.SUCCESS;
}

export async function runCronScheduler(opts: CronCommandOptions): Promise<number> {
  const ctx = await resolveContext(opts);
  const { jobs, errors } = loadCronJobs({
    cronDir: ctx.cronDir,
    defaultTimezone: ctx.defaultTimezone,
  });
  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`  ${e.path}: ${e.reason}`);
    }
  }
  const journal = new CronJournal(ctx.stateDir);
  const telegram = new TelegramSender({
    token: ctx.telegramToken,
    ownerChatId: ctx.ownerChatId,
  });

  const enabled = jobs.filter((j) => j.enabled);
  logger.info(
    {
      jobs_loaded: jobs.length,
      enabled: enabled.length,
      catchup_time: ctx.catchupTime,
    },
    "[cron] scheduler starting",
  );

  // §17.3 #9 (c) — wire the gmail-check if the Google adapter is enabled
  // and credentials are present. Disabled gracefully otherwise.
  const gmailChecker = makeGmailCheckerIfConfigured(ctx.config.google.enabled);

  const sched = startScheduler({
    config: ctx.config,
    jobs,
    journal,
    telegram,
    stateDir: ctx.stateDir,
    cwd: ctx.projectRoot,
    cliPath: ctx.cliPath,
    gmailChecker,
  });

  const shutdown = (reason: string): void => {
    logger.info({ reason }, "[cron] shutting down");
    sched.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return new Promise<number>(() => {
    // never resolves — runs until signal
  });
}

function makeGmailCheckerIfConfigured(
  googleEnabled: boolean,
): ((job: CronJob, scheduledFor: Date) => Promise<boolean>) | undefined {
  if (!googleEnabled) return undefined;
  const creds = credentialsFromEnv(process.env);
  if (!creds) {
    logger.warn(
      "[cron] google.enabled=true but GOOGLE_* env vars missing — gmail-check disabled",
    );
    return undefined;
  }
  const client = makeOAuth2Client(creds);
  return async (job, _scheduledFor) => {
    if (!job.gmail_subject) return false;
    try {
      return await wasSubjectSentRecently(client, job.gmail_subject, 1);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), job_id: job.id },
        "[cron] gmail-check threw — treating as not-sent",
      );
      return false;
    }
  };
}
