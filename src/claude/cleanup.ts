// Scoped stale-process cleanup per docs/architecture.md §17.2 #3.
//
// Before each new claude invocation, kill any stale claude direct-child
// subprocesses left over from previous calls owned by THIS Node process.
//
// CRITICAL: scoped to direct children (pgrep -P $pid), NOT machine-wide.
// A machine-wide `pkill claude` would nuke claude processes owned by
// sibling services (cron runner, heartbeat) and produce cascading
// exit-143 failures. This is a dated production incident in the sibling
// reference codebase.

import { execSync } from "node:child_process";
import { logger } from "../lib/logger.js";

export interface CleanupResult {
  killed: number;
  pids: number[];
}

/**
 * SIGTERM any direct-child claude subprocesses of THIS process (parent pid =
 * process.pid). Excludes a specific currentPid if provided (the call that
 * just completed but hasn't been awaited).
 *
 * Returns the count and list of pids killed. Never throws.
 */
export function killStaleClaude(currentPid?: number): CleanupResult {
  try {
    const output = execSync(`pgrep -P ${process.pid} -f claude || true`, {
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    if (!output) {
      return { killed: 0, pids: [] };
    }
    const candidatePids = output
      .split("\n")
      .map((line) => parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);

    const killed: number[] = [];
    for (const pid of candidatePids) {
      if (pid === currentPid || pid === process.pid) continue;
      try {
        process.kill(pid, "SIGTERM");
        killed.push(pid);
      } catch {
        // pid may have already exited — non-fatal
      }
    }
    if (killed.length > 0) {
      logger.info({ killed: killed.length, pids: killed }, "[claude] cleaned up stale claude processes");
    }
    return { killed: killed.length, pids: killed };
  } catch (err) {
    logger.warn({ err }, "[claude] killStaleClaude threw");
    return { killed: 0, pids: [] };
  }
}
