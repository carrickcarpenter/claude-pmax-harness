// Catch-up triple-check per docs/architecture.md §17.3 #9.
//
// For each enabled job, enumerate the fire times that should have happened
// "today" in the owner's timezone (up to now). For each such fire, check
// in order:
//   1. In-memory completedToday map (this process knows it fired)
//   2. Journal — was there a "success" entry for (job_id, scheduled_for)?
//   3. (DEFERRED — step 9): for delivery=gmail jobs, query Gmail for the
//      expected subject in the last day.
//
// Any fire that fails all three checks is queued for re-fire.

import { logger } from "../lib/logger.js";
import type { CronJob } from "./types.js";
import type { CronJournal } from "./journal.js";
import { fireTimesOnDay, minuteKey } from "./schedule.js";

export interface CatchUpOptions {
  jobs: CronJob[];
  /** Owner timezone — controls "what day is it?". */
  defaultTimezone: string;
  /** In-memory completed-today set (keys: minuteKey:job_id). */
  completedToday: Set<string>;
  /** Journal for source-of-truth checks. */
  journal: CronJournal;
  /** "Now" — overridable for tests. */
  now?: Date;
  /**
   * §17.3 #9 (c) — gmail-check for delivery=gmail jobs. Given a job and its
   * scheduled fire time, returns true if the job's `gmail_subject` was sent
   * by the authenticated user within the last 24h.
   * When omitted (e.g. google adapter disabled or not configured), gmail
   * jobs fall through to the in-memory + journal checks alone.
   */
  gmailChecker?: (
    job: CronJob,
    scheduledFor: Date,
  ) => Promise<boolean>;
}

export interface OverdueFire {
  job: CronJob;
  scheduledFor: Date;
  reason: "no-completion-in-memory" | "no-success-in-journal";
}

export async function findOverdueFires(
  opts: CatchUpOptions,
): Promise<OverdueFire[]> {
  const now = opts.now ?? new Date();
  const overdue: OverdueFire[] = [];

  for (const job of opts.jobs) {
    if (!job.enabled) continue;
    const tz = job.timezone ?? opts.defaultTimezone;
    const todaysFires = fireTimesOnDay(job.schedule, now, tz);
    for (const fire of todaysFires) {
      if (fire.getTime() > now.getTime()) continue; // future fire — not overdue
      const key = `${minuteKey(fire, tz)}:${job.id}`;
      if (opts.completedToday.has(key)) continue;
      if (opts.journal.hasSuccess(job.id, fire)) {
        opts.completedToday.add(key); // memoize what the journal told us
        continue;
      }
      // §17.3 #9 (c) — gmail authoritative check for delivery=gmail jobs.
      if (
        opts.gmailChecker &&
        job.delivery === "gmail" &&
        job.gmail_subject
      ) {
        try {
          const sent = await opts.gmailChecker(job, fire);
          if (sent) {
            opts.completedToday.add(key);
            continue;
          }
        } catch (err) {
          logger.warn(
            { err, job_id: job.id },
            "[catchup] gmail-check threw; falling through to journal-only",
          );
        }
      }
      overdue.push({
        job,
        scheduledFor: fire,
        reason: "no-success-in-journal",
      });
    }
  }
  if (overdue.length > 0) {
    logger.info(
      { count: overdue.length, ids: overdue.map((o) => o.job.id) },
      "[catchup] overdue fires detected",
    );
  }
  return overdue;
}

/**
 * Seed the in-memory completedToday set from the journal at startup so a
 * restart doesn't lose dedup state.
 */
export function seedCompletedTodayFromJournal(
  jobs: CronJob[],
  journal: CronJournal,
  defaultTimezone: string,
  completedToday: Set<string>,
  windowMs: number = 24 * 60 * 60 * 1000,
): void {
  const entries = journal.readSince(windowMs);
  for (const entry of entries) {
    if (entry.status !== "success") continue;
    const job = jobs.find((j) => j.id === entry.job_id);
    if (!job) continue;
    const fire = new Date(entry.scheduled_for);
    if (Number.isNaN(fire.getTime())) continue;
    const tz = job.timezone ?? defaultTimezone;
    completedToday.add(`${minuteKey(fire, tz)}:${job.id}`);
  }
}
