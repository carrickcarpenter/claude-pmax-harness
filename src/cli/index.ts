#!/usr/bin/env node
import { Command } from "commander";
import { runDoctor } from "./commands/doctor.js";
import { runVersion } from "./commands/version.js";
import { runBot } from "./commands/bot.js";
import {
  runCronList,
  runCronRun,
  runCronStatus,
  runCronNext,
  runCronScheduler,
} from "./commands/cron.js";
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
  .command("bot")
  .description(
    "run the Telegram bot in foreground (pm2/systemd invokes this)",
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

program.parseAsync(process.argv).catch(handleError);

function handleError(err: unknown): never {
  if (err instanceof HarnessError) {
    console.error(`\nharness error: ${err.message}\n`);
    process.exit(err.exitCode);
  }
  console.error(`\nharness internal error:`, err);
  process.exit(EXIT_CODES.INTERNAL_ERROR);
}
