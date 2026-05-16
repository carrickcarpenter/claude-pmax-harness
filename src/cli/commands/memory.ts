// `harness memory purge` and `harness memory stats` per docs/architecture.md
// §3 + §18.2.
//
// purge --all       : nuclear; two-step confirmation; calls bridge purge_all
// purge --query Q   : semantic purge; requires MemPalace op support; today
//                     returns a friendly error since the op is UNIMPLEMENTED
//                     in the bridge until MemPalace exposes a delete API.
// purge --range R   : same — pending MemPalace support.
// stats             : counts / oldest / newest / disk usage.

import { resolve } from "node:path";
import { homedir } from "node:os";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";
import { existsSync, rmSync, statSync, readdirSync } from "node:fs";
import { loadConfig } from "../../config/load.js";
import { ConfigError, EXIT_CODES, UserError } from "../../lib/errors.js";
import { MemPalaceBridge } from "../../memory/bridge.js";
import { logger } from "../../lib/logger.js";

export interface MemoryCommandContext {
  projectRoot: string;
}

interface ResolvedDirs {
  dataDir: string;
  palaceDir: string;
}

function resolveDirs(opts: MemoryCommandContext): ResolvedDirs {
  let dataDir: string;
  try {
    const loaded = loadConfig({ projectRoot: opts.projectRoot });
    dataDir =
      loaded.env.HARNESS_DATA_DIR ?? resolve(homedir(), ".claude-pmax-harness");
  } catch (err) {
    if (err instanceof ConfigError) {
      dataDir = process.env.HARNESS_DATA_DIR ?? resolve(homedir(), ".claude-pmax-harness");
    } else {
      throw err;
    }
  }
  return {
    dataDir,
    palaceDir: resolve(dataDir, "data", "mempalace"),
  };
}

// ── stats ───────────────────────────────────────────────────────────────

export async function runMemoryStats(opts: MemoryCommandContext): Promise<number> {
  const dirs = resolveDirs(opts);

  // Try the bridge stats op first; fall back to filesystem stats if the
  // bridge isn't ready or the op is UNIMPLEMENTED.
  const bridge = new MemPalaceBridge({ dataDir: dirs.dataDir });
  let bridgeStats: Record<string, unknown> | null = null;
  try {
    await bridge.start();
    const resp = await bridge.request("stats");
    if (resp.ok) bridgeStats = resp as Record<string, unknown>;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[memory:stats] bridge unavailable — falling back to filesystem stats",
    );
  } finally {
    bridge.close();
  }

  console.log(`MemPalace data dir: ${dirs.palaceDir}`);
  if (existsSync(dirs.palaceDir)) {
    const fs = filesystemStats(dirs.palaceDir);
    console.log(`  on disk: ${fs.files} file(s), ${formatBytes(fs.bytes)}`);
  } else {
    console.log("  (not yet created — run `scripts/install-mempalace.sh` + start the bot once)");
  }
  if (bridgeStats) {
    const { ok: _, request_id: __, ...rest } = bridgeStats;
    console.log("  bridge reports:");
    for (const [k, v] of Object.entries(rest)) {
      console.log(`    ${k}: ${String(v)}`);
    }
  } else {
    console.log("  bridge: unavailable or `stats` op not yet implemented");
  }
  return EXIT_CODES.SUCCESS;
}

// ── purge ───────────────────────────────────────────────────────────────

export interface PurgeOptions extends MemoryCommandContext {
  all?: boolean;
  query?: string;
  range?: string;
  /** Skip the confirmation prompt — for tests only. */
  yes?: boolean;
  /** Reader injection for tests. */
  prompt?: (q: string) => Promise<string>;
}

export async function runMemoryPurge(opts: PurgeOptions): Promise<number> {
  const modes = [opts.all, !!opts.query, !!opts.range].filter(Boolean).length;
  if (modes === 0) {
    throw new UserError(
      "memory purge requires exactly one of: --all, --query <text>, --range YYYY-MM-DD:YYYY-MM-DD",
    );
  }
  if (modes > 1) {
    throw new UserError(
      "memory purge accepts only one of --all, --query, --range at a time",
    );
  }

  const dirs = resolveDirs(opts);

  if (opts.all) return purgeAll(opts, dirs);
  if (opts.query) return purgeQueryOrRange(opts, "purge_query", { query: opts.query });
  if (opts.range) {
    const [from, to] = opts.range.split(":");
    if (!from || !to) {
      throw new UserError("--range must be FROM:TO where FROM and TO are YYYY-MM-DD");
    }
    return purgeQueryOrRange(opts, "purge_range", { from, to });
  }
  return EXIT_CODES.INTERNAL_ERROR;
}

async function purgeAll(
  opts: PurgeOptions,
  dirs: ResolvedDirs,
): Promise<number> {
  // §18.2 #2 — two-step confirmation.
  if (!opts.yes) {
    const reader = opts.prompt ?? makeStdinPrompt();
    const a = await reader(
      `This will permanently delete ALL MemPalace data at ${dirs.palaceDir}.\nThis cannot be undone. Type 'yes' to continue: `,
    );
    if (a.trim().toLowerCase() !== "yes") {
      console.log("Aborted. No changes made.");
      return EXIT_CODES.SUCCESS;
    }
    const b = await reader(`Are you sure? Type 'PURGE' (uppercase) to confirm: `);
    if (b.trim() !== "PURGE") {
      console.log("Aborted. No changes made.");
      return EXIT_CODES.SUCCESS;
    }
  }

  // Prefer the bridge op (lets MemPalace clean up properly) — fall back to
  // filesystem rm if the bridge is unavailable.
  const bridge = new MemPalaceBridge({ dataDir: dirs.dataDir });
  let bridgeOk = false;
  try {
    await bridge.start();
    const resp = await bridge.request("purge_all", { confirm_token: "PURGE" });
    if (resp.ok) {
      bridgeOk = true;
      console.log("Bridge confirms purge_all complete.");
    } else if (resp.code === "UNIMPLEMENTED") {
      // Fall through to filesystem rm
    } else {
      console.error(`Bridge purge_all failed: ${resp.error ?? "unknown"}`);
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[memory:purge] bridge unavailable — using filesystem fallback",
    );
  } finally {
    bridge.close();
  }

  if (!bridgeOk && existsSync(dirs.palaceDir)) {
    rmSync(dirs.palaceDir, { recursive: true, force: true });
    console.log(`Filesystem purge: removed ${dirs.palaceDir}`);
  }
  return EXIT_CODES.SUCCESS;
}

async function purgeQueryOrRange(
  opts: PurgeOptions,
  op: "purge_query" | "purge_range",
  payload: Record<string, unknown>,
): Promise<number> {
  const dirs = resolveDirs(opts);
  const bridge = new MemPalaceBridge({ dataDir: dirs.dataDir });
  try {
    await bridge.start();
    // Dry-run first so the user can see what would be purged.
    const dryRun = await bridge.request(op, { ...payload, dry_run: true });
    if (!dryRun.ok) {
      if (dryRun.code === "UNIMPLEMENTED") {
        console.error(
          `\nThe \`${op}\` op is not yet implemented in the MemPalace bridge.\n` +
            `Reason: MemPalace 3.0.0 does not yet expose a programmatic delete API.\n` +
            `Workaround: use \`harness memory purge --all\` (with two-step confirmation)\n` +
            `to remove the entire store, or manually edit MemPalace data.\n`,
        );
        return EXIT_CODES.EXTERNAL_ERROR;
      }
      console.error(`Bridge ${op} dry-run failed: ${dryRun.error ?? "unknown"}`);
      return EXIT_CODES.EXTERNAL_ERROR;
    }
    const dryRunMatched = (dryRun as unknown as { matched?: unknown[] }).matched;
    const matched = Array.isArray(dryRunMatched) ? dryRunMatched.length : "(unknown)";
    console.log(`Dry-run: would purge ${matched} entries.`);
    if (!opts.yes) {
      const reader = opts.prompt ?? makeStdinPrompt();
      const ans = await reader("Type 'yes' to confirm and execute the purge: ");
      if (ans.trim().toLowerCase() !== "yes") {
        console.log("Aborted. No changes made.");
        return EXIT_CODES.SUCCESS;
      }
    }
    const real = await bridge.request(op, { ...payload, dry_run: false });
    if (!real.ok) {
      console.error(`Bridge ${op} failed: ${real.error ?? "unknown"}`);
      return EXIT_CODES.EXTERNAL_ERROR;
    }
    const purged = (real as { purged?: number }).purged ?? "(unknown)";
    console.log(`Purge complete: ${purged} entries removed.`);
    return EXIT_CODES.SUCCESS;
  } finally {
    bridge.close();
  }
}

function makeStdinPrompt(): (q: string) => Promise<string> {
  let rl: ReadlineInterface | null = null;
  return (question: string) =>
    new Promise<string>((resolveAns) => {
      rl = rl ?? createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => {
        resolveAns(answer);
      });
    });
}

function filesystemStats(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = resolve(d, entry.name);
      try {
        const st = statSync(abs);
        if (entry.isDirectory()) {
          stack.push(abs);
        } else if (entry.isFile()) {
          files += 1;
          bytes += st.size;
        }
      } catch {
        // skip
      }
    }
  }
  return { files, bytes };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
