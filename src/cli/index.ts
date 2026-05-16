#!/usr/bin/env node
import { Command } from "commander";
import { runDoctor } from "./commands/doctor.js";
import { runVersion } from "./commands/version.js";
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

program.parseAsync(process.argv).catch(handleError);

function handleError(err: unknown): never {
  if (err instanceof HarnessError) {
    console.error(`\nharness error: ${err.message}\n`);
    process.exit(err.exitCode);
  }
  console.error(`\nharness internal error:`, err);
  process.exit(EXIT_CODES.INTERNAL_ERROR);
}
