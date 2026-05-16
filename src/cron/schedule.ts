// Cron schedule helpers built on `croner`. Wraps croner's API so the
// scheduler can ask "should this job's schedule fire during the current
// minute?" and "what are the next N fire times?".

import { Cron } from "croner";

/**
 * Returns true iff the cron pattern fires at least once within the
 * inclusive minute window containing `now` (in the given timezone).
 * Used by the tick loop's same-minute dedup logic.
 */
export function shouldFireInMinute(
  pattern: string,
  now: Date,
  timezone: string,
): boolean {
  const start = startOfMinute(now);
  const end = endOfMinute(now);
  const job = new Cron(pattern, { timezone, paused: true });
  // croner v9: previousRun() takes no args; use previousRuns(n, reference)
  // to get the most recent fire <= the given reference.
  const prevs = job.previousRuns(1, end);
  const prev = prevs[0];
  if (!prev) return false;
  return prev.getTime() >= start.getTime() && prev.getTime() <= end.getTime();
}

/**
 * Returns the next N fire times for a pattern starting at `from`.
 * Used by `harness cron next` for operator visibility.
 */
export function nextFireTimes(
  pattern: string,
  n: number,
  from: Date,
  timezone: string,
): Date[] {
  const job = new Cron(pattern, { timezone, paused: true });
  const out: Date[] = [];
  let cursor: Date | null = from;
  for (let i = 0; i < n; i++) {
    cursor = cursor ? job.nextRun(cursor) : null;
    if (!cursor) break;
    out.push(cursor);
    cursor = new Date(cursor.getTime() + 1000); // step past for next iter
  }
  return out;
}

/**
 * Fire times for a single day in a given timezone. Used by the catch-up
 * check to enumerate "fires that should have happened today."
 */
export function fireTimesOnDay(
  pattern: string,
  day: Date,
  timezone: string,
): Date[] {
  const job = new Cron(pattern, { timezone, paused: true });
  const start = startOfDay(day, timezone);
  const end = endOfDay(day, timezone);
  const out: Date[] = [];
  let cursor = job.nextRun(new Date(start.getTime() - 1));
  while (cursor && cursor.getTime() <= end.getTime()) {
    out.push(cursor);
    cursor = job.nextRun(new Date(cursor.getTime() + 1000));
  }
  return out;
}

/**
 * Validate a cron pattern. Returns the error message if invalid, or null
 * if it parses cleanly. Lets the loader surface clear messages.
 */
export function validatePattern(pattern: string, timezone?: string): string | null {
  try {
    new Cron(pattern, { timezone, paused: true });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function startOfMinute(d: Date): Date {
  const c = new Date(d);
  c.setSeconds(0, 0);
  return c;
}

export function endOfMinute(d: Date): Date {
  const c = new Date(d);
  c.setSeconds(59, 999);
  return c;
}

function startOfDay(d: Date, timezone: string): Date {
  // Compute midnight in the target timezone, then convert to a real Date.
  const local = new Date(
    d.toLocaleString("en-US", { timeZone: timezone }),
  );
  local.setHours(0, 0, 0, 0);
  return new Date(local.toLocaleString("en-US", { timeZone: timezone }));
}

function endOfDay(d: Date, timezone: string): Date {
  const local = new Date(
    d.toLocaleString("en-US", { timeZone: timezone }),
  );
  local.setHours(23, 59, 59, 999);
  return new Date(local.toLocaleString("en-US", { timeZone: timezone }));
}

/**
 * Format an instant as a minute-precision dedup key in the given timezone.
 * Format: YYYY-MM-DD-HH-MM.
 */
export function minuteKey(d: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}-${get("hour")}-${get("minute")}`;
}
