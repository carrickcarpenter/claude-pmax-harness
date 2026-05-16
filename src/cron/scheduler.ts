// Main scheduler — tick loop + watchdogs + post-restart catch-up.
//
// Patterns per docs/architecture.md §17.3:
//   #6 tick-stall watchdog: if tick hasn't run in tick_stall_ms, exit
//      so the supervisor (pm2/systemd) restarts on a fresh process.
//   #7 tick interval 30s (configurable).
//   #8 same-minute dedup via minuteKey:job_id.
//   #10 skip-catchup one-shot marker.
//   #11 post-restart catch-up after 60s settling.
//   Daily scheduled catch-up sweep at config.cron.catchup_time.

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../lib/logger.js";
import type { Config } from "../config/schema.js";
import type { CronJob } from "./types.js";
import type { CronJournal } from "./journal.js";
import type { TelegramSender } from "./telegram.js";
import { shouldFireInMinute, minuteKey } from "./schedule.js";
import {
  findOverdueFires,
  seedCompletedTodayFromJournal,
} from "./catchup.js";
import { executeJob, type Invoker } from "./runner.js";

export interface SchedulerOptions {
  config: Config;
  jobs: CronJob[];
  journal: CronJournal;
  telegram?: TelegramSender;
  stateDir: string;
  cwd: string;
  cliPath?: string;
  invoker?: Invoker;
  /** Override exit fn for tests. */
  exit?: (code: number) => void;
  /** Override "now" provider for tests. */
  now?: () => Date;
}

export interface SchedulerHandle {
  stop(): void;
  /** Trigger a single tick — exposed for tests. */
  tick(): Promise<void>;
  /** Trigger catch-up immediately — exposed for tests and `harness cron run --catchup`. */
  catchUp(): Promise<void>;
}

const SKIP_CATCHUP_MARKER = ".skip-catchup-once";
const POST_RESTART_SETTLE_MS = 60_000;
const WATCHDOG_CHECK_MS = 60_000;

export function startScheduler(opts: SchedulerOptions): SchedulerHandle {
  const now = opts.now ?? (() => new Date());
  const exit = opts.exit ?? ((code) => process.exit(code));
  const defaultTimezone = opts.config.owner.timezone;

  mkdirSync(opts.stateDir, { recursive: true });

  // In-memory dedup — keys: `${minuteKey}:${job_id}`
  const completedToday = new Set<string>();
  seedCompletedTodayFromJournal(
    opts.jobs,
    opts.journal,
    defaultTimezone,
    completedToday,
  );

  let lastTick = Date.now();
  const firingNow = new Set<string>(); // suppress within a single tick

  const tick = async (): Promise<void> => {
    lastTick = Date.now();
    const currentNow = now();
    firingNow.clear();

    // Scheduled catch-up: if we're within the same minute as catchup_time,
    // run the sweep once (dedup via the marker key).
    if (
      isAtTargetTime(currentNow, opts.config.cron.catchup_time, defaultTimezone) &&
      !completedToday.has(catchupSweepKey(currentNow, defaultTimezone))
    ) {
      completedToday.add(catchupSweepKey(currentNow, defaultTimezone));
      void runCatchUp(); // fire-and-forget; doesn't block normal scheduling
    }

    for (const job of opts.jobs) {
      if (!job.enabled) continue;
      const jobTz = job.timezone ?? defaultTimezone;
      if (!shouldFireInMinute(job.schedule, currentNow, jobTz)) continue;
      const key = `${minuteKey(currentNow, jobTz)}:${job.id}`;
      if (completedToday.has(key) || firingNow.has(key)) continue;
      firingNow.add(key);
      completedToday.add(key);

      // Fire async — don't block other jobs in this tick.
      void executeAndLog({ job, scheduledFor: snapToMinute(currentNow) });
    }
  };

  const runCatchUp = async (): Promise<void> => {
    const overdue = findOverdueFires({
      jobs: opts.jobs,
      defaultTimezone,
      completedToday,
      journal: opts.journal,
      now: now(),
    });
    if (overdue.length === 0) {
      logger.info("[scheduler] catch-up: nothing overdue");
      return;
    }
    if (opts.telegram) {
      const list = overdue.map((o) => o.job.name).join(", ");
      await opts.telegram
        .send(`Catch-up: re-running ${overdue.length} missed job(s): ${list}`)
        .catch((err) => logger.warn({ err }, "[scheduler] catch-up alert failed"));
    }
    for (const o of overdue) {
      const key = `${minuteKey(o.scheduledFor, o.job.timezone ?? defaultTimezone)}:${o.job.id}`;
      completedToday.add(key);
      await executeAndLog({ job: o.job, scheduledFor: o.scheduledFor });
    }
  };

  const executeAndLog = async (args: { job: CronJob; scheduledFor: Date }): Promise<void> => {
    try {
      await executeJob({
        job: args.job,
        scheduledFor: args.scheduledFor,
        cwd: opts.cwd,
        cliPath: opts.cliPath,
        journal: opts.journal,
        telegram: opts.telegram,
        invoker: opts.invoker,
        maxAttempts: opts.config.cron.retry.max_attempts,
        retryDelayMs: opts.config.cron.retry.backoff_seconds * 1000,
      });
    } catch (err) {
      logger.error({ err, job_id: args.job.id }, "[scheduler] executeJob threw");
    }
  };

  // Start ticking
  const tickTimer = setInterval(() => {
    tick().catch((err) => logger.error({ err }, "[scheduler] tick threw"));
  }, opts.config.cron.tick_interval_ms);
  tickTimer.unref?.();

  // Fire one tick immediately so jobs scheduled at startup-minute don't wait.
  void tick();

  // §17.3 #6 — tick stall watchdog
  const watchdogTimer = setInterval(() => {
    const stale = Date.now() - lastTick;
    if (stale > opts.config.cron.tick_stall_ms) {
      logger.error(
        { stale_ms: stale, threshold_ms: opts.config.cron.tick_stall_ms },
        "[scheduler] tick stalled — exiting for supervisor restart",
      );
      clearInterval(tickTimer);
      clearInterval(watchdogTimer);
      exit(1);
    }
  }, WATCHDOG_CHECK_MS);
  watchdogTimer.unref?.();

  // §17.3 #10 + #11 — post-restart catch-up after settling, unless the
  // skip-marker is present (consumed once).
  const skipMarker = resolve(opts.stateDir, SKIP_CATCHUP_MARKER);
  setTimeout(() => {
    if (existsSync(skipMarker)) {
      try {
        unlinkSync(skipMarker);
      } catch {
        // ignore
      }
      logger.info("[scheduler] post-restart catch-up: skipped (marker consumed)");
      return;
    }
    void runCatchUp();
  }, POST_RESTART_SETTLE_MS).unref?.();

  return {
    stop() {
      clearInterval(tickTimer);
      clearInterval(watchdogTimer);
    },
    tick,
    catchUp: runCatchUp,
  };
}

function isAtTargetTime(now: Date, target: string, timezone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hh}:${mm}` === target;
}

function catchupSweepKey(now: Date, timezone: string): string {
  return `__catchup__:${minuteKey(now, timezone)}`;
}

function snapToMinute(d: Date): Date {
  const c = new Date(d);
  c.setSeconds(0, 0);
  return c;
}
