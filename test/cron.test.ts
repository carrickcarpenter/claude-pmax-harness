import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import { loadCronJobs } from "../src/cron/loader.js";
import {
  shouldFireInMinute,
  nextFireTimes,
  fireTimesOnDay,
  minuteKey,
} from "../src/cron/schedule.js";
import { CronJournal, type JournalEntry } from "../src/cron/journal.js";
import { executeJob, ANTI_SELF_TALK_DIRECTIVE } from "../src/cron/runner.js";
import {
  findOverdueFires,
  seedCompletedTodayFromJournal,
} from "../src/cron/catchup.js";
import type { CronJob } from "../src/cron/types.js";
import type { InvokeOptions, InvokeResult } from "../src/claude/invoke.js";

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "cron-test-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const TZ = "America/New_York";

function writeJob(rel: string, frontmatter: string, body: string = "Hi"): void {
  const fullDir = resolve(tmpRoot, "cron");
  mkdirSync(fullDir, { recursive: true });
  writeFileSync(resolve(fullDir, rel), `---\n${frontmatter}\n---\n${body}\n`);
}

// ── loader ───────────────────────────────────────────────────────────────

describe("loadCronJobs", () => {
  test("returns empty result when dir doesn't exist", () => {
    const { jobs, errors } = loadCronJobs({
      cronDir: resolve(tmpRoot, "missing"),
      defaultTimezone: TZ,
    });
    expect(jobs).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("loads valid frontmatter and applies defaults", () => {
    writeJob(
      "test-job.md",
      ["id: test-job", 'name: Test Job', 'schedule: "*/5 * * * *"'].join("\n"),
      "Body content",
    );
    const { jobs, errors } = loadCronJobs({
      cronDir: resolve(tmpRoot, "cron"),
      defaultTimezone: TZ,
    });
    expect(errors).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe("test-job");
    expect(jobs[0]!.model).toBe("sonnet"); // default
    expect(jobs[0]!.timeout_ms).toBe(600_000); // default
    expect(jobs[0]!.delivery).toBe("silent"); // default
    expect(jobs[0]!.persistent_session).toBe(false); // default
    expect(jobs[0]!.enabled).toBe(true); // default
    expect(jobs[0]!.timezone).toBe(TZ); // injected default
    expect(jobs[0]!.instruction).toBe("Body content");
  });

  test("rejects invalid id format", () => {
    writeJob(
      "bad.md",
      ["id: HasUppercase", "name: Bad", "schedule: \"* * * * *\""].join("\n"),
    );
    const { jobs, errors } = loadCronJobs({
      cronDir: resolve(tmpRoot, "cron"),
      defaultTimezone: TZ,
    });
    expect(jobs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.reason).toContain("id");
  });

  test("rejects missing instruction body", () => {
    const dir = resolve(tmpRoot, "cron");
    mkdirSync(dir);
    writeFileSync(
      resolve(dir, "empty.md"),
      `---\nid: x\nname: X\nschedule: "* * * * *"\n---\n\n`,
    );
    const { jobs, errors } = loadCronJobs({ cronDir: dir, defaultTimezone: TZ });
    expect(jobs).toEqual([]);
    expect(errors[0]!.reason).toContain("instruction");
  });

  test("rejects bad timeout_ms (below minimum)", () => {
    writeJob(
      "x.md",
      ["id: x", "name: X", "schedule: \"* * * * *\"", "timeout_ms: 1000"].join("\n"),
    );
    const { errors } = loadCronJobs({
      cronDir: resolve(tmpRoot, "cron"),
      defaultTimezone: TZ,
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.reason).toContain("timeout_ms");
  });

  test("detects duplicate ids and keeps the first", () => {
    writeJob(
      "a.md",
      ["id: dup", "name: A", "schedule: \"* * * * *\""].join("\n"),
    );
    writeJob(
      "b.md",
      ["id: dup", "name: B", "schedule: \"* * * * *\""].join("\n"),
    );
    const { jobs, errors } = loadCronJobs({
      cronDir: resolve(tmpRoot, "cron"),
      defaultTimezone: TZ,
    });
    expect(jobs).toHaveLength(1);
    expect(errors.some((e) => /duplicate id/.test(e.reason))).toBe(true);
  });

  test("ignores dotfiles and non-md files", () => {
    const dir = resolve(tmpRoot, "cron");
    mkdirSync(dir);
    writeFileSync(resolve(dir, ".hidden.md"), `---\nid: x\nname: X\nschedule: "* * * * *"\n---\nbody`);
    writeFileSync(resolve(dir, "notes.txt"), "not cron");
    writeJob(
      "real.md",
      ["id: real", "name: Real", "schedule: \"* * * * *\""].join("\n"),
    );
    const { jobs } = loadCronJobs({ cronDir: dir, defaultTimezone: TZ });
    expect(jobs.map((j) => j.id)).toEqual(["real"]);
  });
});

// ── schedule ─────────────────────────────────────────────────────────────

describe("schedule helpers", () => {
  test("shouldFireInMinute matches a wildcard pattern in any minute", () => {
    expect(shouldFireInMinute("* * * * *", new Date("2026-05-16T12:30:00Z"), TZ)).toBe(true);
  });

  test("shouldFireInMinute respects timezone offset", () => {
    // 12:30 UTC = 8:30 EDT (DST in May). Pattern fires at 8:30 in NY.
    const at1230Utc = new Date("2026-05-16T12:30:00Z");
    expect(shouldFireInMinute("30 8 * * *", at1230Utc, TZ)).toBe(true);
    // 12:31 UTC = 8:31 EDT — wrong minute
    const at1231Utc = new Date("2026-05-16T12:31:00Z");
    expect(shouldFireInMinute("30 8 * * *", at1231Utc, TZ)).toBe(false);
  });

  test("nextFireTimes returns N strictly-increasing fires", () => {
    const fires = nextFireTimes(
      "0 8 * * *",
      3,
      new Date("2026-05-16T00:00:00Z"),
      TZ,
    );
    expect(fires).toHaveLength(3);
    expect(fires[1]!.getTime()).toBeGreaterThan(fires[0]!.getTime());
    expect(fires[2]!.getTime()).toBeGreaterThan(fires[1]!.getTime());
  });

  test("fireTimesOnDay returns all fires within a day window", () => {
    // every-3-hours pattern in NY on May 16 (DST EDT = UTC-4)
    const fires = fireTimesOnDay("0 */3 * * *", new Date("2026-05-16T12:00:00Z"), TZ);
    expect(fires.length).toBeGreaterThanOrEqual(8);
  });

  test("minuteKey formats deterministically in the requested TZ", () => {
    const at = new Date("2026-05-16T12:30:00Z");
    const utc = minuteKey(at, "Etc/UTC");
    expect(utc).toBe("2026-05-16-12-30");
    const ny = minuteKey(at, TZ);
    expect(ny).toBe("2026-05-16-08-30");
  });
});

// ── journal ──────────────────────────────────────────────────────────────

describe("CronJournal", () => {
  test("append + tail round-trip", () => {
    const journal = new CronJournal(tmpRoot);
    journal.append({
      job_id: "test",
      scheduled_for: "2026-05-16T12:30:00.000Z",
      attempt: 1,
      status: "success",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    });
    const tail = journal.tail(5);
    expect(tail).toHaveLength(1);
    expect(tail[0]!.job_id).toBe("test");
  });

  test("hasSuccess returns true only for matching job + scheduled_for + status=success", () => {
    const journal = new CronJournal(tmpRoot);
    const at = new Date("2026-05-16T12:30:00.000Z");
    journal.append({
      job_id: "j",
      scheduled_for: at.toISOString(),
      attempt: 1,
      status: "failure",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    });
    expect(journal.hasSuccess("j", at)).toBe(false);
    journal.append({
      job_id: "j",
      scheduled_for: at.toISOString(),
      attempt: 2,
      status: "success",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    });
    expect(journal.hasSuccess("j", at)).toBe(true);
  });

  test("readSince skips malformed lines (partial writes from crashes)", () => {
    const journal = new CronJournal(tmpRoot);
    journal.append({
      job_id: "ok",
      scheduled_for: "2026-05-16T00:00:00.000Z",
      attempt: 1,
      status: "success",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    });
    // simulate a partial line
    const fs = require("node:fs") as typeof import("node:fs");
    fs.appendFileSync(journal.path, `{ not valid json\n`);
    fs.appendFileSync(
      journal.path,
      JSON.stringify({
        job_id: "later",
        scheduled_for: "2026-05-16T01:00:00.000Z",
        attempt: 1,
        status: "success",
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      } as JournalEntry) + "\n",
    );
    const entries = journal.readSince(24 * 60 * 60 * 1000);
    expect(entries.map((e) => e.job_id)).toEqual(["ok", "later"]);
  });
});

// ── runner ───────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job",
    name: "Test Job",
    schedule: "* * * * *",
    timezone: TZ,
    model: "sonnet",
    timeout_ms: 60_000,
    delivery: "silent",
    persistent_session: false,
    tools: ["Read"],
    enabled: true,
    instruction: "do the thing",
    source_path: "/tmp/fake.md",
    ...overrides,
  };
}

function successResult(text: string = "ok"): InvokeResult {
  return {
    text,
    sessionId: "s1",
    durationMs: 5,
    flagged: { flagged: false },
  };
}

describe("executeJob", () => {
  test("appends anti-self-talk directive to the instruction", async () => {
    const calls: InvokeOptions[] = [];
    const invoker = async (opts: InvokeOptions): Promise<InvokeResult> => {
      calls.push(opts);
      return successResult();
    };
    const journal = new CronJournal(tmpRoot);
    await executeJob({
      job: makeJob(),
      scheduledFor: new Date(),
      cwd: tmpRoot,
      journal,
      invoker,
    });
    expect(calls[0]!.prompt).toContain("do the thing");
    expect(calls[0]!.prompt).toContain("EXECUTION RULES");
    expect(calls[0]!.prompt.endsWith(ANTI_SELF_TALK_DIRECTIVE)).toBe(true);
  });

  test("passes per-job model + timeout + tools through to the invoker", async () => {
    const calls: InvokeOptions[] = [];
    const invoker = async (opts: InvokeOptions): Promise<InvokeResult> => {
      calls.push(opts);
      return successResult();
    };
    const journal = new CronJournal(tmpRoot);
    await executeJob({
      job: makeJob({ model: "haiku", timeout_ms: 120_000, tools: ["Read", "WebSearch"] }),
      scheduledFor: new Date(),
      cwd: tmpRoot,
      journal,
      invoker,
    });
    expect(calls[0]!.model).toBe("haiku");
    expect(calls[0]!.timeoutMs).toBe(120_000);
    expect(calls[0]!.allowedTools).toEqual(["Read", "WebSearch"]);
  });

  test("retries on transient failure, succeeds on second attempt", async () => {
    let attempts = 0;
    const invoker = async (): Promise<InvokeResult> => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
      return successResult("recovered");
    };
    const journal = new CronJournal(tmpRoot);
    const result = await executeJob({
      job: makeJob(),
      scheduledFor: new Date(),
      cwd: tmpRoot,
      journal,
      invoker,
      sleep: async () => {}, // skip the 2-min wait
    });
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(attempts).toBe(2);
  });

  test("treats flagged response as failure and retries", async () => {
    let attempts = 0;
    const invoker = async (): Promise<InvokeResult> => {
      attempts += 1;
      if (attempts === 1) {
        return {
          text: "Sorry, I hit an error.",
          sessionId: "s1",
          durationMs: 5,
          flagged: { flagged: true, category: "soft-apology", reason: "x" },
        };
      }
      return successResult();
    };
    const journal = new CronJournal(tmpRoot);
    const result = await executeJob({
      job: makeJob(),
      scheduledFor: new Date(),
      cwd: tmpRoot,
      journal,
      invoker,
      sleep: async () => {},
    });
    expect(result.success).toBe(true);
    expect(attempts).toBe(2);
  });

  test("exhausts retries and sends self-healing alert via telegram", async () => {
    const invoker = async (): Promise<InvokeResult> => {
      throw new Error("permanent");
    };
    const sent: string[] = [];
    const telegram = {
      async send(t: string) {
        sent.push(t);
        return true;
      },
    } as unknown as import("../src/cron/telegram.js").TelegramSender;
    const journal = new CronJournal(tmpRoot);
    const result = await executeJob({
      job: makeJob({ delivery: "telegram" }),
      scheduledFor: new Date(),
      cwd: tmpRoot,
      journal,
      telegram,
      invoker,
      sleep: async () => {},
    });
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(2);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[sent.length - 1]).toContain("failed");
    expect(sent[sent.length - 1]).toContain("Test Job");
  });

  test("delivery=silent does NOT send an alert even on full failure", async () => {
    const invoker = async (): Promise<InvokeResult> => {
      throw new Error("dead");
    };
    const sent: string[] = [];
    const telegram = {
      async send(t: string) {
        sent.push(t);
        return true;
      },
    } as unknown as import("../src/cron/telegram.js").TelegramSender;
    const journal = new CronJournal(tmpRoot);
    await executeJob({
      job: makeJob({ delivery: "silent" }),
      scheduledFor: new Date(),
      cwd: tmpRoot,
      journal,
      telegram,
      invoker,
      sleep: async () => {},
    });
    expect(sent).toEqual([]);
  });

  test("delivery=telegram sends the result text on success", async () => {
    const sent: string[] = [];
    const telegram = {
      async send(t: string) {
        sent.push(t);
        return true;
      },
    } as unknown as import("../src/cron/telegram.js").TelegramSender;
    const journal = new CronJournal(tmpRoot);
    const invoker = async () => successResult("Good morning!");
    await executeJob({
      job: makeJob({ delivery: "telegram" }),
      scheduledFor: new Date(),
      cwd: tmpRoot,
      journal,
      telegram,
      invoker,
    });
    expect(sent).toEqual(["Good morning!"]);
  });

  test("logs both started + success entries in the journal", async () => {
    const journal = new CronJournal(tmpRoot);
    const invoker = async () => successResult();
    await executeJob({
      job: makeJob(),
      scheduledFor: new Date("2026-05-16T12:30:00Z"),
      cwd: tmpRoot,
      journal,
      invoker,
    });
    const entries = journal.tail(10);
    expect(entries.map((e) => e.status)).toEqual(["started", "success"]);
  });
});

// ── catchup ──────────────────────────────────────────────────────────────

describe("findOverdueFires", () => {
  test("returns [] when there are no enabled jobs", async () => {
    const journal = new CronJournal(tmpRoot);
    const out = await findOverdueFires({
      jobs: [makeJob({ enabled: false })],
      defaultTimezone: TZ,
      completedToday: new Set(),
      journal,
      now: new Date(),
    });
    expect(out).toEqual([]);
  });

  test("detects a fire that happened earlier today but isn't completed", async () => {
    const journal = new CronJournal(tmpRoot);
    // 8:30 fire, current 11:00 — overdue if not completed.
    const out = await findOverdueFires({
      jobs: [makeJob({ schedule: "30 8 * * *", timezone: TZ })],
      defaultTimezone: TZ,
      completedToday: new Set(),
      journal,
      now: new Date("2026-05-16T15:00:00Z"), // 11:00 EDT
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.job.id).toBe("test-job");
  });

  test("skips fires the journal already records as successful", async () => {
    const journal = new CronJournal(tmpRoot);
    // The fire we're asking about can be any past date — what matters is
    // that the journal entry's started_at falls within the last 24h
    // (journal.hasSuccess uses Date.now() as the window anchor). Set both
    // to real-now so this test is robust against day rollovers.
    const fireTime = new Date("2026-05-16T12:30:00Z"); // 8:30 EDT
    const nowIso = new Date().toISOString();
    journal.append({
      job_id: "test-job",
      scheduled_for: fireTime.toISOString(),
      attempt: 1,
      status: "success",
      started_at: nowIso,
      finished_at: nowIso,
    });
    const out = await findOverdueFires({
      jobs: [makeJob({ schedule: "30 8 * * *", timezone: TZ })],
      defaultTimezone: TZ,
      completedToday: new Set(),
      journal,
      now: new Date("2026-05-16T15:00:00Z"),
    });
    expect(out).toEqual([]);
  });

  test("skips fires the in-memory completedToday set already records", async () => {
    const journal = new CronJournal(tmpRoot);
    const fireTime = new Date("2026-05-16T12:30:00Z");
    const completedToday = new Set<string>();
    completedToday.add(`${minuteKey(fireTime, TZ)}:test-job`);
    const out = await findOverdueFires({
      jobs: [makeJob({ schedule: "30 8 * * *", timezone: TZ })],
      defaultTimezone: TZ,
      completedToday,
      journal,
      now: new Date("2026-05-16T15:00:00Z"),
    });
    expect(out).toEqual([]);
  });
});

describe("seedCompletedTodayFromJournal", () => {
  test("populates set from recent journal success entries", () => {
    const journal = new CronJournal(tmpRoot);
    const fire = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    journal.append({
      job_id: "test-job",
      scheduled_for: fire.toISOString(),
      attempt: 1,
      status: "success",
      started_at: fire.toISOString(),
      finished_at: fire.toISOString(),
    });
    const set = new Set<string>();
    seedCompletedTodayFromJournal([makeJob()], journal, TZ, set);
    expect(set.size).toBe(1);
    expect([...set][0]).toContain("test-job");
  });

  test("doesn't include entries outside the window", () => {
    const journal = new CronJournal(tmpRoot);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000); // 2 days ago
    journal.append({
      job_id: "test-job",
      scheduled_for: old.toISOString(),
      attempt: 1,
      status: "success",
      started_at: old.toISOString(),
      finished_at: old.toISOString(),
    });
    const set = new Set<string>();
    seedCompletedTodayFromJournal(
      [makeJob()],
      journal,
      TZ,
      set,
      24 * 60 * 60 * 1000,
    );
    expect(set.size).toBe(0);
  });
});
