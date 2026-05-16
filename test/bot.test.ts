import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  splitMessage,
  sendChunked,
  TELEGRAM_MAX_MESSAGE,
  type ReplyContext,
} from "../src/bot/messaging.js";
import { isAuthorized, makeAccessGate } from "../src/bot/access.js";
import { ConversationBuffer } from "../src/bot/conversation-buffer.js";
import { ErrorLog } from "../src/bot/error-log.js";
import { BotWatchdog } from "../src/bot/watchdog.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "bot-test-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── messaging ────────────────────────────────────────────────────────────

describe("splitMessage", () => {
  test("returns the input as a single chunk when under the limit", () => {
    expect(splitMessage("short message")).toEqual(["short message"]);
  });

  test("splits at paragraph boundary when possible", () => {
    // Make sure the total exceeds TELEGRAM_MAX_MESSAGE so splitting is forced.
    const para = "X".repeat(3000);
    const text = `${para}\n\n${para}\n\nfinal small bit`;
    expect(text.length).toBeGreaterThan(TELEGRAM_MAX_MESSAGE);
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE);
    }
    expect(chunks.join(" ")).toContain("final small bit");
  });

  test("splits exactly at the max when no good break exists", () => {
    const text = "x".repeat(TELEGRAM_MAX_MESSAGE + 100);
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE);
    expect(chunks[1]!.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE);
    expect(chunks.join("")).toHaveLength(TELEGRAM_MAX_MESSAGE + 100);
  });
});

describe("sendChunked", () => {
  test("tries Markdown first; falls back to plain on parse_mode rejection", async () => {
    const calls: Array<{ text: string; parse_mode?: string }> = [];
    const ctx: ReplyContext = {
      async reply(text, options) {
        if (options?.parse_mode === "Markdown") {
          calls.push({ text, parse_mode: options.parse_mode });
          throw new Error("Bad Markdown");
        }
        calls.push({ text });
        return {};
      },
    };
    await sendChunked(ctx, "hello _world_");
    // Two calls: one Markdown attempt, one plain fallback
    expect(calls).toHaveLength(2);
    expect(calls[0]!.parse_mode).toBe("Markdown");
    expect(calls[1]!.parse_mode).toBeUndefined();
    expect(calls[1]!.text).toBe("hello _world_");
  });

  test("chunks long messages across multiple replies", async () => {
    const calls: string[] = [];
    const ctx: ReplyContext = {
      async reply(text) {
        calls.push(text);
        return {};
      },
    };
    const text = "x".repeat(TELEGRAM_MAX_MESSAGE + 500);
    await sendChunked(ctx, text);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.join("")).toHaveLength(text.length);
  });
});

// ── access ───────────────────────────────────────────────────────────────

describe("isAuthorized + makeAccessGate", () => {
  test("authorized when from.id matches ownerChatId", () => {
    expect(
      isAuthorized({ from: { id: 12345 }, chat: { id: 12345 } }, 12345),
    ).toBe(true);
  });

  test("authorized via chat.id even when from is absent", () => {
    expect(isAuthorized({ chat: { id: 12345 } }, "12345")).toBe(true);
  });

  test("not authorized when both ids differ", () => {
    expect(
      isAuthorized({ from: { id: 99 }, chat: { id: 99 } }, 12345),
    ).toBe(false);
  });

  test("middleware drops unauthorized and calls next for authorized", async () => {
    const gate = makeAccessGate({ ownerChatId: 12345 });

    let calledNextA = false;
    await gate({ from: { id: 12345 } }, async () => {
      calledNextA = true;
    });
    expect(calledNextA).toBe(true);

    let calledNextB = false;
    await gate({ from: { id: 99 } }, async () => {
      calledNextB = true;
    });
    expect(calledNextB).toBe(false);
  });
});

// ── conversation buffer ─────────────────────────────────────────────────

describe("ConversationBuffer", () => {
  test("creates state dir on instantiation", () => {
    const stateDir = resolve(tmpRoot, "sessions");
    expect(existsSync(stateDir)).toBe(false);
    new ConversationBuffer({ stateDir });
    expect(existsSync(stateDir)).toBe(true);
  });

  test("load returns [] when no file exists for chatId", () => {
    const buf = new ConversationBuffer({ stateDir: tmpRoot });
    expect(buf.load(42)).toEqual([]);
  });

  test("append + load round-trips an entry", () => {
    const buf = new ConversationBuffer({ stateDir: tmpRoot });
    buf.append(42, "what time is it?", "10:30 AM");
    const loaded = buf.load(42);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.user_message).toBe("what time is it?");
    expect(loaded[0]!.assistant_response).toBe("10:30 AM");
    expect(typeof loaded[0]!.timestamp).toBe("string");
  });

  test("truncates to maxEntries (FIFO drop of oldest)", () => {
    const buf = new ConversationBuffer({ stateDir: tmpRoot, maxEntries: 3 });
    for (let i = 0; i < 5; i++) buf.append(7, `u${i}`, `a${i}`);
    const loaded = buf.load(7);
    expect(loaded).toHaveLength(3);
    expect(loaded.map((e) => e.user_message)).toEqual(["u2", "u3", "u4"]);
  });

  test("truncates user/assistant text per configured caps", () => {
    const buf = new ConversationBuffer({
      stateDir: tmpRoot,
      userMessageMaxChars: 10,
      assistantResponseMaxChars: 5,
    });
    buf.append(7, "x".repeat(20), "y".repeat(20));
    const loaded = buf.load(7);
    expect(loaded[0]!.user_message).toHaveLength(10);
    expect(loaded[0]!.assistant_response).toHaveLength(5);
  });

  test("clear empties the per-chat file", () => {
    const buf = new ConversationBuffer({ stateDir: tmpRoot });
    buf.append(7, "u", "a");
    expect(buf.load(7)).toHaveLength(1);
    buf.clear(7);
    expect(buf.load(7)).toEqual([]);
  });

  test("sanitizes chatId so it can't escape the state dir", () => {
    const buf = new ConversationBuffer({ stateDir: tmpRoot });
    buf.append("../etc/passwd" as unknown as string, "u", "a");
    // "../etc/passwd" sanitizes to "___etc_passwd" (3 leading underscores
    // from . . / which are all replaced).
    const sanitizedPath = resolve(tmpRoot, "___etc_passwd.json");
    expect(existsSync(sanitizedPath)).toBe(true);
    const written = readFileSync(sanitizedPath, "utf-8");
    expect(written).toContain('"user_message"');
    // And confirm we didn't accidentally escape — nothing exists outside tmpRoot
    expect(existsSync(resolve(tmpRoot, "..", "etc", "passwd"))).toBe(false);
  });

  test("survives a corrupt JSON file by returning []", () => {
    const buf = new ConversationBuffer({ stateDir: tmpRoot });
    writeFileSync(resolve(tmpRoot, "7.json"), "{ not valid json");
    expect(buf.load(7)).toEqual([]);
  });

  test("formatForInjection includes the continuity hint when entries exist", () => {
    const buf = new ConversationBuffer({ stateDir: tmpRoot });
    const out = buf.formatForInjection([
      { user_message: "hi", assistant_response: "hello", timestamp: "t" },
    ]);
    expect(out).toContain("Recent conversation thread");
    expect(out).toContain("hi");
    expect(out).toContain("hello");
  });

  test("formatForInjection returns empty string when no entries", () => {
    const buf = new ConversationBuffer({ stateDir: tmpRoot });
    expect(buf.formatForInjection([])).toBe("");
  });
});

// ── error log ────────────────────────────────────────────────────────────

describe("ErrorLog", () => {
  test("verifyWritable creates error.log and appends a startup entry", () => {
    const el = new ErrorLog(tmpRoot);
    el.verifyWritable();
    expect(existsSync(el.errorPath)).toBe(true);
    const contents = readFileSync(el.errorPath, "utf-8");
    expect(contents).toContain("startup");
    expect(contents).toContain("error log writable");
  });

  test("appendError + tailErrors returns recent entries", () => {
    const el = new ErrorLog(tmpRoot);
    el.verifyWritable();
    el.appendError("test-context", { foo: "bar", n: 42 });
    const tail = el.tailErrors(5);
    expect(tail).toContain("test-context");
    expect(tail).toContain("foo: bar");
  });

  test("appendResponse + tailResponses formats per-turn entries", () => {
    const el = new ErrorLog(tmpRoot);
    el.appendResponse({
      timestamp: "2026-05-16T14:00:00Z",
      elapsed_ms: 1234,
      prompt_head: "hello",
      response_head: "world",
      response_tail: "world",
      response_length: 5,
      session_id: "s1",
      flagged: false,
    });
    const tail = el.tailResponses(5);
    expect(tail).toContain("hello");
    expect(tail).toContain("world");
    expect(tail).toContain("OK");
    expect(tail).toContain("session: s1");
  });

  test("clearErrors empties error.log", () => {
    const el = new ErrorLog(tmpRoot);
    el.verifyWritable();
    el.appendError("ctx", { x: 1 });
    el.clearErrors();
    expect(readFileSync(el.errorPath, "utf-8")).toBe("");
  });
});

// ── watchdog ─────────────────────────────────────────────────────────────

describe("BotWatchdog", () => {
  test("clears failure count on a successful probe", async () => {
    const api = { getMe: vi.fn().mockResolvedValue({ id: 1 }) };
    const wd = new BotWatchdog(api, { exit: vi.fn() });
    await wd.probe();
    expect(wd.failureCount).toBe(0);
  });

  test("increments failures on getMe rejection", async () => {
    const api = { getMe: vi.fn().mockRejectedValue(new Error("boom")) };
    const exit = vi.fn();
    const wd = new BotWatchdog(api, { exit, maxFailures: 5 });
    await wd.probe();
    expect(wd.failureCount).toBe(1);
    expect(exit).not.toHaveBeenCalled();
  });

  test("recovers (resets count) after a failure followed by success", async () => {
    let calls = 0;
    const api = {
      getMe: vi.fn().mockImplementation(async () => {
        calls += 1;
        if (calls === 1) throw new Error("fail once");
        return { id: 1 };
      }),
    };
    const wd = new BotWatchdog(api, { exit: vi.fn(), maxFailures: 5 });
    await wd.probe();
    expect(wd.failureCount).toBe(1);
    await wd.probe();
    expect(wd.failureCount).toBe(0);
  });

  test("calls exit(1) after maxFailures consecutive probe failures", async () => {
    const api = { getMe: vi.fn().mockRejectedValue(new Error("boom")) };
    const exit = vi.fn();
    const onWedged = vi.fn();
    const wd = new BotWatchdog(api, { exit, maxFailures: 3, onWedged });
    await wd.probe();
    await wd.probe();
    expect(exit).not.toHaveBeenCalled();
    await wd.probe();
    expect(exit).toHaveBeenCalledWith(1);
    expect(onWedged).toHaveBeenCalledWith(3, "boom");
  });

  test("probe timeout fires when getMe never resolves", async () => {
    const api = { getMe: vi.fn().mockImplementation(() => new Promise(() => {})) };
    const wd = new BotWatchdog(api, {
      exit: vi.fn(),
      probeTimeoutMs: 50,
      maxFailures: 10,
    });
    await wd.probe();
    expect(wd.failureCount).toBe(1);
  });
});
