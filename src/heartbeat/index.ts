// Heartbeat ticker per PLAN.md v1 deliverable + config.assistant.heartbeat.
//
// Every N hours (in owner timezone), reads personal/heartbeat.md as a
// prompt, invokes claude, and sends the result via Telegram UNLESS:
//   - quiet hours are in effect, OR
//   - the response is the literal `HEARTBEAT_OK` marker, OR
//   - the response is empty.
//
// The heartbeat prompt should make the assistant return HEARTBEAT_OK when
// there's nothing worth surfacing — see templates/heartbeat.md.template.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "../config/schema.js";
import { invokeClaude, type InvokeOptions, type InvokeResult } from "../claude/invoke.js";
import { TelegramSender } from "../cron/telegram.js";
import { logger } from "../lib/logger.js";

export type HeartbeatInvoker = (opts: InvokeOptions) => Promise<InvokeResult>;

export interface HeartbeatOptions {
  config: Config;
  cwd: string;
  cliPath?: string;
  telegram: TelegramSender;
  /** Override for tests. */
  invoker?: HeartbeatInvoker;
  /** Override now provider for tests. */
  now?: () => Date;
  /** Override exit fn for tests. */
  exit?: (code: number) => void;
  /** First-tick delay to let the rest of the harness settle. Default 5 min. */
  firstTickDelayMs?: number;
}

export const HEARTBEAT_OK_MARKER = "HEARTBEAT_OK";
const DEFAULT_FIRST_TICK_DELAY_MS = 5 * 60 * 1000;

export class Heartbeat {
  private intervalTimer: NodeJS.Timeout | null = null;
  private firstTimer: NodeJS.Timeout | null = null;
  private readonly opts: HeartbeatOptions;
  private readonly now: () => Date;
  private readonly invoker: HeartbeatInvoker;
  private readonly personalDir: string;

  constructor(opts: HeartbeatOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
    this.invoker = opts.invoker ?? invokeClaude;
    this.personalDir = resolve(opts.cwd, "personal");
  }

  /** Start the heartbeat. No-op if config.assistant.heartbeat.enabled is false. */
  start(): void {
    if (!this.opts.config.assistant.heartbeat.enabled) {
      logger.info("[heartbeat] disabled by config; not starting");
      return;
    }
    const everyMs = this.opts.config.assistant.heartbeat.every_hours * 60 * 60 * 1000;
    const firstDelay = this.opts.firstTickDelayMs ?? DEFAULT_FIRST_TICK_DELAY_MS;
    logger.info(
      {
        every_hours: this.opts.config.assistant.heartbeat.every_hours,
        quiet: this.opts.config.assistant.heartbeat.quiet_hours,
        first_tick_in_ms: firstDelay,
      },
      "[heartbeat] starting",
    );
    this.firstTimer = setTimeout(() => {
      void this.tick();
      this.intervalTimer = setInterval(() => {
        void this.tick();
      }, everyMs);
      this.intervalTimer.unref?.();
    }, firstDelay);
    this.firstTimer.unref?.();
  }

  stop(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.firstTimer = null;
    this.intervalTimer = null;
  }

  /** Exposed for tests + manual invocation. */
  async tick(): Promise<void> {
    const t = this.now();
    if (this.isQuietHours(t)) {
      logger.info({ hour: this.localHour(t) }, "[heartbeat] quiet hours, skipping");
      return;
    }

    const promptPath = resolve(this.personalDir, "heartbeat.md");
    if (!existsSync(promptPath)) {
      logger.warn(
        { path: promptPath },
        "[heartbeat] personal/heartbeat.md not found; skipping (run setup or copy the template)",
      );
      return;
    }
    const prompt = readFileSync(promptPath, "utf-8");
    let result: InvokeResult;
    try {
      result = await this.invoker({
        prompt,
        cliPath: this.opts.cliPath,
        cwd: this.opts.cwd,
        timeoutMs: 5 * 60 * 1000,
        allowedTools: this.opts.config.tools.allow_dangerous
          ? ["WebSearch", "WebFetch", "Bash", "Read", "Write", "Edit", "Glob", "Grep"]
          : ["WebSearch", "WebFetch", "Read", "Glob", "Grep"],
      });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "[heartbeat] invocation failed",
      );
      return;
    }

    if (result.flagged.flagged) {
      logger.warn(
        { reason: result.flagged.reason },
        "[heartbeat] flagged response; not sending",
      );
      return;
    }
    const text = result.text.trim();
    if (!text || text.includes(HEARTBEAT_OK_MARKER)) {
      logger.info("[heartbeat] all clear (OK marker or empty)");
      return;
    }
    await this.opts.telegram.send(text).catch((err) =>
      logger.warn({ err }, "[heartbeat] telegram send failed"),
    );
    logger.info("[heartbeat] sent");
  }

  isQuietHours(t: Date = this.now()): boolean {
    const { start, end } = this.opts.config.assistant.heartbeat.quiet_hours;
    return inQuietWindow(this.localHourMinute(t), start, end);
  }

  /** "HH:MM" of `t` in owner timezone. */
  localHourMinute(t: Date): string {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: this.opts.config.owner.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(t);
    const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
    const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
    return `${hh}:${mm}`;
  }

  localHour(t: Date): number {
    return parseInt(this.localHourMinute(t).split(":")[0]!, 10);
  }
}

/**
 * Returns true iff `now` (HH:MM string) is within the quiet-hours window
 * [start, end). Handles the wrap-around case where end < start (i.e.
 * quiet window crosses midnight — the common case).
 */
export function inQuietWindow(now: string, start: string, end: string): boolean {
  const n = hmToMinutes(now);
  const s = hmToMinutes(start);
  const e = hmToMinutes(end);
  if (s === e) return false; // zero-width window
  if (s < e) {
    return n >= s && n < e;
  }
  // wrap-around: e.g. start=22:00 end=07:00 → quiet from 22:00 to midnight
  // AND from midnight to 07:00
  return n >= s || n < e;
}

function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(":");
  return parseInt(h ?? "0", 10) * 60 + parseInt(m ?? "0", 10);
}
