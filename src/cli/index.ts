#!/usr/bin/env node
import { Command } from "commander";
import { runDoctor } from "./commands/doctor.js";
import { runVersion } from "./commands/version.js";
import { runBot } from "./commands/bot.js";
import { runStart } from "./commands/start.js";
import {
  runCronList,
  runCronRun,
  runCronStatus,
  runCronNext,
  runCronScheduler,
} from "./commands/cron.js";
import { runPiiCheck } from "./commands/pii-check.js";
import { runMemoryStats, runMemoryPurge } from "./commands/memory.js";
import { runSetup } from "./commands/setup.js";
import { runGoogleLogin, runGoogleTest } from "./commands/google.js";
import { HarnessError, EXIT_CODES } from "../lib/errors.js";

// projectRoot defaults to cwd. Future setup wizard will allow overriding via env.
const projectRoot = process.cwd();

const program = new Command();

program
  .name("harness")
  .description(
    "claude-pmax-harness — a Pro Max harness for chat + scheduled jobs + memory",
  )
  .version("0.1.0");

program
  .command("version")
  .description("print harness version + runtime versions")
  .action(() => {
    runVersion();
  });

program
  .command("setup")
  .description("first-run interactive wizard — collects identity, Telegram, PII prefs; renders templates/")
  .option("--non-interactive", "fail rather than prompt; combine with preset flags below for scripted/CI setup")
  .option("--force", "overwrite existing personal/ files (each gets a .bak sidecar)")
  .option("--chat-id <id>", "skip the chat_id prompt (e.g. when not on Telegram during setup)")
  .option("--owner-name <name>", "preset: owner display name")
  .option("--timezone <tz>", "preset: IANA timezone (e.g. America/New_York)")
  .option("--assistant-name <name>", "preset: what the assistant calls itself")
  .option("--telegram-token <token>", "preset: Telegram bot token")
  .option("--google", "preset: enable Google adapter opt-in (default no)")
  .option("--precommit-hook", "preset: install PII pre-commit hook (default no)")
  .option("--no-allow-dangerous", "preset: drop Bash/Write/Edit from chat tools (default allowed)")
  .action(
    async (options: {
      nonInteractive?: boolean;
      force?: boolean;
      chatId?: string;
      ownerName?: string;
      timezone?: string;
      assistantName?: string;
      telegramToken?: string;
      google?: boolean;
      precommitHook?: boolean;
      allowDangerous?: boolean;
    }) => {
      try {
        const exitCode = await runSetup({
          projectRoot,
          nonInteractive: options.nonInteractive,
          force: options.force,
          chatId: options.chatId,
          ownerName: options.ownerName,
          timezone: options.timezone,
          assistantName: options.assistantName,
          telegramToken: options.telegramToken,
          googleEnabled: options.google,
          precommitHook: options.precommitHook,
          allowDangerous: options.allowDangerous,
        });
        process.exit(exitCode);
      } catch (err) {
        handleError(err);
      }
    },
  );

program
  .command("doctor")
  .description("verify environment, prereqs, config, and permissions")
  .option(
    "--fix",
    "auto-repair issues that have a safe fix (e.g. chmod .env to 600)",
  )
  .action(async (options: { fix?: boolean }) => {
    try {
      const exitCode = await runDoctor({ projectRoot, fix: options.fix });
      process.exit(exitCode);
    } catch (err) {
      handleError(err);
    }
  });

program
  .command("start")
  .description(
    "run the full harness in foreground (MemPalace bridge + Telegram bot + cron scheduler). This is what pm2/systemd invokes.",
  )
  .action(async () => {
    try {
      const exitCode = await runStart({ projectRoot });
      process.exit(exitCode);
    } catch (err) {
      handleError(err);
    }
  });

program
  .command("bot")
  .description(
    "run ONLY the Telegram bot in foreground (without cron). Most users want `harness start`.",
  )
  .action(async () => {
    try {
      const exitCode = await runBot({ projectRoot });
      process.exit(exitCode);
    } catch (err) {
      handleError(err);
    }
  });

const cron = program
  .command("cron")
  .description("scheduled jobs — run the scheduler or inspect job state")
  .action(async () => {
    try {
      const exitCode = await runCronScheduler({ projectRoot });
      process.exit(exitCode);
    } catch (err) {
      handleError(err);
    }
  });

cron
  .command("list")
  .description("list discovered cron jobs and their schedules")
  .action(async () => {
    try {
      const exitCode = await runCronList({ projectRoot });
      process.exit(exitCode);
    } catch (err) {
      handleError(err);
    }
  });

cron
  .command("run <job-id>")
  .description("fire a single job immediately, bypassing the schedule")
  .action(async (jobId: string) => {
    try {
      const exitCode = await runCronRun({ projectRoot, jobId });
      process.exit(exitCode);
    } catch (err) {
      handleError(err);
    }
  });

cron
  .command("status")
  .description("show the last 20 journal entries")
  .action(async () => {
    try {
      const exitCode = await runCronStatus({ projectRoot });
      process.exit(exitCode);
    } catch (err) {
      handleError(err);
    }
  });

cron
  .command("next")
  .description("show the next N fire times across all enabled jobs")
  .option("-n, --count <count>", "how many fires to show", "10")
  .action(async (options: { count?: string }) => {
    try {
      const n = parseInt(options.count ?? "10", 10);
      const exitCode = await runCronNext({ projectRoot, n: Number.isFinite(n) ? n : 10 });
      process.exit(exitCode);
    } catch (err) {
      handleError(err);
    }
  });

program
  .command("pii-check")
  .description("scan personal/ for PII category-shaped strings (reports counts, never values)")
  .option("--staged", "scan only files staged for commit (used by the pre-commit hook)")
  .option("--install-hook", "install the opt-in pre-commit hook into .git/hooks/")
  .option("--uninstall-hook", "remove the pre-commit hook installed by this harness")
  .action(async (options: { staged?: boolean; installHook?: boolean; uninstallHook?: boolean }) => {
    try {
      const exitCode = await runPiiCheck({
        projectRoot,
        staged: options.staged,
        installHook: options.installHook,
        uninstallHook: options.uninstallHook,
      });
      process.exit(exitCode);
    } catch (err) {
      handleError(err);
    }
  });

const memory = program
  .command("memory")
  .description("MemPalace operations (stats, purge)");

memory
  .command("stats")
  .description("show MemPalace store stats (counts, disk usage, date range)")
  .action(async () => {
    try {
      const exitCode = await runMemoryStats({ projectRoot });
      process.exit(exitCode);
    } catch (err) {
      handleError(err);
    }
  });

memory
  .command("purge")
  .description("purge MemPalace entries — requires exactly one of --all / --query / --range")
  .option("--all", "purge ALL data (two-step confirmation)")
  .option("--query <text>", "purge entries semantically matching this query")
  .option("--range <range>", "purge entries in date range FROM:TO (YYYY-MM-DD:YYYY-MM-DD)")
  .option("--yes", "skip confirmation prompts (for scripted use; not recommended)")
  .action(
    async (options: {
      all?: boolean;
      query?: string;
      range?: string;
      yes?: boolean;
    }) => {
      try {
        const exitCode = await runMemoryPurge({
          projectRoot,
          all: options.all,
          query: options.query,
          range: options.range,
          yes: options.yes,
        });
        process.exit(exitCode);
      } catch (err) {
        handleError(err);
      }
    },
  );

const google = program
  .command("google")
  .description("Google adapter — OAuth login + connectivity test");

google
  .command("login")
  .description("run the OAuth flow (opens a temp HTTP server for the callback)")
  .action(async () => {
    try {
      const exitCode = await runGoogleLogin({ projectRoot });
      process.exit(exitCode);
    } catch (err) {
      handleError(err);
    }
  });

google
  .command("test")
  .description("verify Google connectivity (lists 1-day inbox + upcoming events)")
  .action(async () => {
    try {
      const exitCode = await runGoogleTest({ projectRoot });
      process.exit(exitCode);
    } catch (err) {
      handleError(err);
    }
  });

program.parseAsync(process.argv).catch(handleError);

function handleError(err: unknown): never {
  if (err instanceof HarnessError) {
    console.error(`\nharness error: ${err.message}\n`);
    process.exit(err.exitCode);
  }
  console.error(`\nharness internal error:`, err);
  process.exit(EXIT_CODES.INTERNAL_ERROR);
}
