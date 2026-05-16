import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  Heartbeat,
  inQuietWindow,
  HEARTBEAT_OK_MARKER,
} from "../src/heartbeat/index.js";
import { ConfigSchema, type Config } from "../src/config/schema.js";
import type { InvokeOptions, InvokeResult } from "../src/claude/invoke.js";
import type { TelegramSender } from "../src/cron/telegram.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "heartbeat-test-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<Config["assistant"]["heartbeat"]> = {}): Config {
  return ConfigSchema.parse({
    owner: { name: "TestUser", timezone: "Etc/UTC" },
    assistant: {
      heartbeat: {
        enabled: true,
        every_hours: 4,
        quiet_hours: { start: "22:00", end: "07:00" },
        ...overrides,
      },
    },
  });
}

function makeTelegramStub(): { sent: string[]; sender: TelegramSender } {
  const sent: string[] = [];
  const sender = {
    async send(text: string) {
      sent.push(text);
      return true;
    },
  } as unknown as TelegramSender;
  return { sent, sender };
}

function makeInvoker(text: string): (opts: InvokeOptions) => Promise<InvokeResult> {
  return async () => ({
    text,
    sessionId: "stub",
    durationMs: 5,
    flagged: { flagged: false },
  });
}

function writeHeartbeatPrompt(projectRoot: string, content = "do your thing"): void {
  mkdirSync(resolve(projectRoot, "personal"), { recursive: true });
  writeFileSync(resolve(projectRoot, "personal", "heartbeat.md"), content);
}

// ── inQuietWindow (pure function) ───────────────────────────────────────

describe("inQuietWindow", () => {
  test("non-wrap-around window: 13:00–17:00 — inside vs outside", () => {
    expect(inQuietWindow("14:00", "13:00", "17:00")).toBe(true);
    expect(inQuietWindow("13:00", "13:00", "17:00")).toBe(true); // start inclusive
    expect(inQuietWindow("17:00", "13:00", "17:00")).toBe(false); // end exclusive
    expect(inQuietWindow("12:59", "13:00", "17:00")).toBe(false);
    expect(inQuietWindow("17:01", "13:00", "17:00")).toBe(false);
  });

  test("wrap-around window: 22:00–07:00 — late night + early morning quiet", () => {
    expect(inQuietWindow("22:00", "22:00", "07:00")).toBe(true);
    expect(inQuietWindow("23:30", "22:00", "07:00")).toBe(true);
    expect(inQuietWindow("00:00", "22:00", "07:00")).toBe(true);
    expect(inQuietWindow("03:00", "22:00", "07:00")).toBe(true);
    expect(inQuietWindow("06:59", "22:00", "07:00")).toBe(true);
    expect(inQuietWindow("07:00", "22:00", "07:00")).toBe(false);
    expect(inQuietWindow("10:00", "22:00", "07:00")).toBe(false);
    expect(inQuietWindow("21:59", "22:00", "07:00")).toBe(false);
  });

  test("zero-width window: start == end is never quiet", () => {
    expect(inQuietWindow("00:00", "12:00", "12:00")).toBe(false);
    expect(inQuietWindow("12:00", "12:00", "12:00")).toBe(false);
  });
});

// ── Heartbeat.tick ──────────────────────────────────────────────────────

describe("Heartbeat.tick", () => {
  test("no-op when heartbeat.enabled is false (start() returns immediately)", () => {
    const config = makeConfig({ enabled: false });
    const { sender } = makeTelegramStub();
    const hb = new Heartbeat({
      config,
      cwd: tmpRoot,
      telegram: sender,
      now: () => new Date("2026-05-16T15:00:00Z"),
    });
    hb.start();
    // No invoker call: start() doesn't schedule anything when disabled
    expect((hb as unknown as { intervalTimer: unknown }).intervalTimer).toBeNull();
    hb.stop();
  });

  test("skips when in quiet hours, never calls invoker or telegram", async () => {
    const config = makeConfig(); // quiet 22:00–07:00 UTC
    const { sent, sender } = makeTelegramStub();
    writeHeartbeatPrompt(tmpRoot);
    let invokerCalled = false;
    const invoker = async (): Promise<InvokeResult> => {
      invokerCalled = true;
      return {
        text: "should not be sent",
        sessionId: "stub",
        durationMs: 0,
        flagged: { flagged: false },
      };
    };
    const hb = new Heartbeat({
      config,
      cwd: tmpRoot,
      telegram: sender,
      invoker,
      now: () => new Date("2026-05-16T02:30:00Z"), // 02:30 UTC, quiet
    });
    await hb.tick();
    expect(invokerCalled).toBe(false);
    expect(sent).toEqual([]);
  });

  test("missing personal/heartbeat.md: skips silently with a warn log", async () => {
    const config = makeConfig();
    const { sent, sender } = makeTelegramStub();
    // intentionally do NOT write heartbeat.md
    let invokerCalled = false;
    const invoker = async (): Promise<InvokeResult> => {
      invokerCalled = true;
      return {
        text: "x",
        sessionId: "stub",
        durationMs: 0,
        flagged: { flagged: false },
      };
    };
    const hb = new Heartbeat({
      config,
      cwd: tmpRoot,
      telegram: sender,
      invoker,
      now: () => new Date("2026-05-16T15:00:00Z"),
    });
    await hb.tick();
    expect(invokerCalled).toBe(false);
    expect(sent).toEqual([]);
  });

  test("HEARTBEAT_OK response: does not send a Telegram message", async () => {
    const config = makeConfig();
    const { sent, sender } = makeTelegramStub();
    writeHeartbeatPrompt(tmpRoot);
    const hb = new Heartbeat({
      config,
      cwd: tmpRoot,
      telegram: sender,
      invoker: makeInvoker(HEARTBEAT_OK_MARKER),
      now: () => new Date("2026-05-16T15:00:00Z"),
    });
    await hb.tick();
    expect(sent).toEqual([]);
  });

  test("non-empty non-OK response: sends to Telegram", async () => {
    const config = makeConfig();
    const { sent, sender } = makeTelegramStub();
    writeHeartbeatPrompt(tmpRoot);
    const hb = new Heartbeat({
      config,
      cwd: tmpRoot,
      telegram: sender,
      invoker: makeInvoker("Heads up: meeting in 30 min you haven't prepped for."),
      now: () => new Date("2026-05-16T15:00:00Z"),
    });
    await hb.tick();
    expect(sent).toEqual(["Heads up: meeting in 30 min you haven't prepped for."]);
  });

  test("empty response: does not send", async () => {
    const config = makeConfig();
    const { sent, sender } = makeTelegramStub();
    writeHeartbeatPrompt(tmpRoot);
    const hb = new Heartbeat({
      config,
      cwd: tmpRoot,
      telegram: sender,
      invoker: makeInvoker(""),
      now: () => new Date("2026-05-16T15:00:00Z"),
    });
    await hb.tick();
    expect(sent).toEqual([]);
  });

  test("flagged response (error-shape): does not send", async () => {
    const config = makeConfig();
    const { sent, sender } = makeTelegramStub();
    writeHeartbeatPrompt(tmpRoot);
    const invoker = async (): Promise<InvokeResult> => ({
      text: "Sorry, I hit an error.",
      sessionId: "stub",
      durationMs: 0,
      flagged: { flagged: true, category: "soft-apology", reason: "x" },
    });
    const hb = new Heartbeat({
      config,
      cwd: tmpRoot,
      telegram: sender,
      invoker,
      now: () => new Date("2026-05-16T15:00:00Z"),
    });
    await hb.tick();
    expect(sent).toEqual([]);
  });

  test("invoker throws: tick returns cleanly, nothing sent", async () => {
    const config = makeConfig();
    const { sent, sender } = makeTelegramStub();
    writeHeartbeatPrompt(tmpRoot);
    const invoker = vi.fn().mockRejectedValue(new Error("CLI broke"));
    const hb = new Heartbeat({
      config,
      cwd: tmpRoot,
      telegram: sender,
      invoker,
      now: () => new Date("2026-05-16T15:00:00Z"),
    });
    await hb.tick();
    expect(sent).toEqual([]);
  });

  test("isQuietHours honors owner.timezone (NY 22:00 = UTC 02:00 EST)", () => {
    const config = ConfigSchema.parse({
      owner: { name: "U", timezone: "America/New_York" },
      assistant: {
        heartbeat: {
          enabled: true,
          every_hours: 4,
          quiet_hours: { start: "22:00", end: "07:00" },
        },
      },
    });
    const { sender } = makeTelegramStub();
    const hb = new Heartbeat({
      config,
      cwd: tmpRoot,
      telegram: sender,
      now: () => new Date("2026-12-01T03:00:00Z"), // 22:00 EST on Nov 30
    });
    expect(hb.isQuietHours()).toBe(true);
    const hb2 = new Heartbeat({
      config,
      cwd: tmpRoot,
      telegram: sender,
      now: () => new Date("2026-12-01T20:00:00Z"), // 15:00 EST
    });
    expect(hb2.isQuietHours()).toBe(false);
  });
});
