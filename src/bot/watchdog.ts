// grammY bot wedge watchdog per docs/architecture.md §17.4 #1.
//
// Every intervalMs, probe `bot.api.getMe()` with a hard timeout. After
// maxFailures consecutive failures, exit the process so the supervisor
// (pm2/systemd) restarts on a fresh polling connection.
//
// grammY's internal long-poll can silently wedge for hours without crashing
// the process. Dated incidents in the sibling reference codebase
// (2026-04-19, 2026-04-21) drove this pattern.

import { logger } from "../lib/logger.js";

export interface ApiLike {
  getMe(): Promise<{ id: number; username?: string } | unknown>;
}

export interface WatchdogOptions {
  /** Polling interval. Default 5 min. */
  intervalMs?: number;
  /** Max consecutive failures before exit. Default 3 (= 15 min on default interval). */
  maxFailures?: number;
  /** Per-probe timeout. Default 15s. */
  probeTimeoutMs?: number;
  /** Exit fn — overridable for tests. */
  exit?: (code: number) => void;
  /** Notification when threshold hit — overridable for tests. */
  onWedged?: (failures: number, lastError: string) => void;
}

export class BotWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private readonly intervalMs: number;
  private readonly maxFailures: number;
  private readonly probeTimeoutMs: number;
  private readonly exit: (code: number) => void;
  private readonly onWedged?: (failures: number, lastError: string) => void;

  constructor(
    private readonly api: ApiLike,
    opts: WatchdogOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
    this.maxFailures = opts.maxFailures ?? 3;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 15_000;
    this.exit = opts.exit ?? ((code) => process.exit(code));
    this.onWedged = opts.onWedged;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.probe().catch((err) => {
        logger.error({ err }, "[watchdog] probe loop error");
      });
    }, this.intervalMs);
    // Don't keep the event loop alive solely for this timer.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Single probe — exposed for tests. */
  async probe(): Promise<void> {
    try {
      await Promise.race([
        this.api.getMe(),
        new Promise((_, rej) =>
          setTimeout(
            () => rej(new Error("getMe timeout")),
            this.probeTimeoutMs,
          ),
        ),
      ]);
      if (this.failures > 0) {
        logger.info(
          { previous_failures: this.failures },
          "[watchdog] recovered",
        );
      }
      this.failures = 0;
    } catch (err) {
      this.failures += 1;
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { failures: this.failures, max: this.maxFailures, error: msg },
        "[watchdog] getMe failed",
      );
      if (this.failures >= this.maxFailures) {
        logger.error(
          { failures: this.failures, last_error: msg },
          "[watchdog] threshold reached — exiting for supervisor restart",
        );
        this.onWedged?.(this.failures, msg);
        this.stop();
        this.exit(1);
      }
    }
  }

  get failureCount(): number {
    return this.failures;
  }
}
