// Cron journal — append-only NDJSON record of every fire attempt.
// Crash-resilient: on startup the scheduler reads recent entries to seed the
// "completed today" dedup map, so a restart doesn't double-fire jobs.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { logger } from "../lib/logger.js";

export type JournalStatus = "started" | "success" | "failure" | "retry";

export interface JournalEntry {
  job_id: string;
  scheduled_for: string; // ISO timestamp
  attempt: number;
  status: JournalStatus;
  started_at: string;
  finished_at?: string;
  duration_ms?: number;
  error?: string;
  claude_session_id?: string;
}

export class CronJournal {
  readonly path: string;

  constructor(stateDir: string) {
    this.path = resolve(stateDir, "cron-journal.ndjson");
    mkdirSync(dirname(this.path), { recursive: true });
  }

  append(entry: JournalEntry): void {
    try {
      appendFileSync(this.path, JSON.stringify(entry) + "\n");
    } catch (err) {
      logger.error({ err, path: this.path }, "[cron-journal] write failed");
    }
  }

  /**
   * Read all entries from the last `sinceMs` milliseconds. Returns valid
   * lines only — malformed/partial lines are dropped silently (logged at
   * debug level).
   */
  readSince(sinceMs: number): JournalEntry[] {
    if (!existsSync(this.path)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf-8");
    } catch (err) {
      logger.warn({ err, path: this.path }, "[cron-journal] read failed");
      return [];
    }
    const cutoff = Date.now() - sinceMs;
    const out: JournalEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as JournalEntry;
        const ts = parsed.finished_at ?? parsed.started_at;
        if (!ts) continue;
        const t = Date.parse(ts);
        if (Number.isFinite(t) && t >= cutoff) out.push(parsed);
      } catch {
        // Partial line (probably from a crash mid-write) — skip.
      }
    }
    return out;
  }

  /**
   * Returns true if the journal contains a `success` entry for this job_id
   * with the given scheduled_for timestamp (within the last `sinceMs` window).
   */
  hasSuccess(jobId: string, scheduledFor: Date, sinceMs: number = 86_400_000): boolean {
    const target = scheduledFor.toISOString();
    for (const entry of this.readSince(sinceMs)) {
      if (
        entry.job_id === jobId &&
        entry.status === "success" &&
        entry.scheduled_for === target
      ) {
        return true;
      }
    }
    return false;
  }

  /** Tail the last N entries — for `harness cron status`. */
  tail(n: number = 20): JournalEntry[] {
    const all = this.readSince(7 * 86_400_000);
    return all.slice(-n);
  }
}
