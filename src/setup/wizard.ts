// Setup wizard orchestrator per docs/architecture.md §7.
//
// Step order (per §7 with the adjustments locked in step 4/§17):
//   1. Privacy gate (offer PRIVACY.md before continuing)
//   2. Prereq check (runs `harness doctor` internally, non-fatal warn)
//   3. Owner identity (name, timezone, assistant name) — cheap, builds
//      user confidence before the riskiest step
//   4. MemPalace install (calls scripts/install-mempalace.sh; warns on
//      failure but does not abort the wizard)
//   5. Telegram bot (token + chat_id; --chat-id flag is an escape hatch
//      for "I'm not on Telegram right now")
//   6. Google adapter (prompt opt-in; the actual OAuth wiring lands in
//      step 9 — wizard records the choice in personal/config.yaml)
//   7. Template rendering (Mustache against templates/)
//   8. Cron defaults (copy templates/cron/ into personal/cron/ if empty)
//   9. PII hygiene questions (precommit hook opt-in; restricted mode opt-in)
//  10. Summary screen
//  11. Doctor re-run

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import * as yaml from "js-yaml";
import {
  ask,
  askYesNo,
  validateNonEmpty,
  validateTimezone,
  validateTelegramToken,
  validateChatId,
  type Prompter,
} from "./prompts.js";
import { renderTemplates, seedCronDefaults, type RenderReport } from "./templates.js";
import { installHook } from "../pii/precommit.js";
import { runDoctor } from "../cli/commands/doctor.js";
import { logger } from "../lib/logger.js";

export interface WizardOptions {
  projectRoot: string;
  prompter: Prompter;
  /** --non-interactive: fail rather than prompt for missing values. */
  nonInteractive?: boolean;
  /** --force: overwrite existing personal/ files (with .bak sidecar). */
  force?: boolean;
  /** Pre-supplied values (used by --non-interactive and --chat-id). */
  preset?: {
    owner_name?: string;
    timezone?: string;
    assistant_name?: string;
    telegram_token?: string;
    telegram_chat_id?: string;
    google_enabled?: boolean;
    precommit_hook?: boolean;
    allow_dangerous?: boolean;
  };
  /** Skip MemPalace install (used by tests). */
  skipMemPalaceInstall?: boolean;
  /** Skip the final doctor re-run (used by tests). */
  skipDoctor?: boolean;
}

export interface WizardResult {
  rendered: RenderReport;
  cronSeed: RenderReport;
  installed_hook: boolean;
  config_path: string;
  env_path: string;
  doctor_exit?: number;
  mempalace_install_ok?: boolean;
}

export async function runWizard(opts: WizardOptions): Promise<WizardResult> {
  const personalDir = resolve(opts.projectRoot, "personal");
  const templatesDir = resolve(opts.projectRoot, "templates");
  const configPath = resolve(personalDir, "config.yaml");
  const envPath = resolve(opts.projectRoot, ".env");

  const existing = loadExistingConfig(configPath);

  // 1. Privacy gate
  if (!opts.nonInteractive) {
    await askYesNo(
      opts.prompter,
      "Read PRIVACY.md before continuing? (recommended, not required)",
      { default: false },
    );
    // We don't open the file or block — just plant awareness.
  }

  // 2. Prereq check — warn-only, never fatal. Catches missing claude CLI /
  // bad Python before we start writing files. Doctor runs again at step 11
  // for the final green-light.
  if (!opts.skipDoctor) {
    const exitCode = await runDoctor({ projectRoot: opts.projectRoot });
    if (exitCode !== 0) {
      console.log(
        "\n[wizard] doctor reported issues above. Continuing the setup anyway —\n" +
          "          you can re-run `harness doctor --fix` afterwards.\n",
      );
    }
  }

  // 3. Owner identity
  const owner_name = await ask(opts.prompter, "Your name?", {
    default: existing?.owner?.name,
    preset: opts.preset?.owner_name,
    validate: validateNonEmpty("name"),
  });
  const timezone = await ask(opts.prompter, "Your IANA timezone?", {
    default: existing?.owner?.timezone ?? "America/New_York",
    preset: opts.preset?.timezone,
    validate: validateTimezone(),
  });
  const assistant_name = await ask(
    opts.prompter,
    "What should the assistant call itself?",
    {
      default: existing?.assistant?.name ?? "Assistant",
      preset: opts.preset?.assistant_name,
      validate: validateNonEmpty("assistant name"),
    },
  );

  // 4. MemPalace install (run script, non-fatal on failure)
  let mempalace_install_ok: boolean | undefined;
  if (!opts.skipMemPalaceInstall) {
    mempalace_install_ok = runInstallMempalace(opts.projectRoot);
  }

  // 5. Telegram
  const existing_env = loadExistingEnv(envPath);
  const telegram_token = await ask(opts.prompter, "Telegram bot token?", {
    default: existing_env?.TELEGRAM_BOT_TOKEN,
    preset: opts.preset?.telegram_token,
    validate: validateTelegramToken(),
  });
  const telegram_chat_id = await ask(
    opts.prompter,
    "Your Telegram chat ID (the bot ignores all other users)?",
    {
      default: existing_env?.TELEGRAM_OWNER_CHAT_ID,
      preset: opts.preset?.telegram_chat_id,
      validate: validateChatId(),
    },
  );

  // 6. Google adapter (record opt-in; actual OAuth lands in step 9)
  const google_enabled = await askYesNo(
    opts.prompter,
    "Enable Google integration (Gmail/Calendar/Drive)? Adapter not yet shipped — this records the choice for v0.2.",
    {
      default: existing?.google?.enabled ?? false,
      preset: opts.preset?.google_enabled,
    },
  );

  // 7. Template rendering
  const rendered = renderTemplates({
    templatesDir,
    personalDir,
    view: {
      owner: { name: owner_name, timezone, first_name: owner_name.split(/\s+/)[0] ?? owner_name },
      assistant_name,
    },
    force: opts.force,
  });

  // 8. Cron defaults — copy from templates/cron/ if personal/cron/ empty
  const cronSeed = seedCronDefaults({
    templatesCronDir: resolve(templatesDir, "cron"),
    personalCronDir: resolve(personalDir, "cron"),
    force: opts.force,
  });

  // 9. PII hygiene (asked AFTER cron seed per §7 ordering)
  const precommit_hook = await askYesNo(
    opts.prompter,
    "Install opt-in pre-commit hook to warn on PII in staged files outside personal/?",
    {
      default: existing?.pii?.precommit_hook ?? false,
      preset: opts.preset?.precommit_hook,
    },
  );
  const allow_dangerous = await askYesNo(
    opts.prompter,
    "Allow dangerous chat tools (Bash, Write, Edit)? Default ON for power users; set OFF for restricted chat mode.",
    {
      default: existing?.tools?.allow_dangerous ?? true,
      preset: opts.preset?.allow_dangerous,
    },
  );

  // Write .env and personal/config.yaml after all answers are in.
  writeEnv(envPath, telegram_token, telegram_chat_id, existing_env);
  writeConfigYaml(configPath, {
    owner_name,
    timezone,
    assistant_name,
    google_enabled,
    precommit_hook,
    allow_dangerous,
    existing,
  });

  // Install pre-commit hook if opted in
  let installed_hook = false;
  if (precommit_hook) {
    const result = installHook(opts.projectRoot);
    installed_hook = result.installed;
    if (!result.installed) {
      logger.warn({ reason: result.reason }, "[wizard] precommit hook install failed");
    }
  }

  // 10. Summary
  if (!opts.nonInteractive) {
    printSummary({
      personalDir,
      envPath,
      rendered,
      cronSeed,
      installed_hook,
      mempalace_install_ok,
    });
  }

  // 11. Doctor re-run
  let doctor_exit: number | undefined;
  if (!opts.skipDoctor) {
    doctor_exit = await runDoctor({ projectRoot: opts.projectRoot });
  }

  return {
    rendered,
    cronSeed,
    installed_hook,
    config_path: configPath,
    env_path: envPath,
    doctor_exit,
    mempalace_install_ok,
  };
}

interface ExistingConfig {
  owner?: { name?: string; timezone?: string };
  assistant?: { name?: string };
  google?: { enabled?: boolean };
  pii?: { precommit_hook?: boolean };
  tools?: { allow_dangerous?: boolean };
}

function loadExistingConfig(path: string): ExistingConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return yaml.load(raw) as ExistingConfig;
  } catch {
    return null;
  }
}

function loadExistingEnv(path: string): Record<string, string> | null {
  if (!existsSync(path)) return null;
  const out: Record<string, string> = {};
  try {
    const raw = readFileSync(path, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key) out[key] = value;
    }
    return out;
  } catch {
    return null;
  }
}

function writeEnv(
  envPath: string,
  telegramToken: string,
  telegramChatId: string,
  existing: Record<string, string> | null,
): void {
  const env: Record<string, string> = {
    ...(existing ?? {}),
    TELEGRAM_BOT_TOKEN: telegramToken,
    TELEGRAM_OWNER_CHAT_ID: telegramChatId,
  };
  const lines = [
    "# claude-pmax-harness — environment",
    "# Generated/updated by `harness setup`. Edit by hand or re-run setup.",
    "",
  ];
  for (const [k, v] of Object.entries(env)) {
    lines.push(`${k}=${v}`);
  }
  writeFileSync(envPath, lines.join("\n") + "\n");
  try {
    chmodSync(envPath, 0o600);
  } catch {
    // best-effort; Windows/WSL may not honor
  }
}

interface ConfigWriteArgs {
  owner_name: string;
  timezone: string;
  assistant_name: string;
  google_enabled: boolean;
  precommit_hook: boolean;
  allow_dangerous: boolean;
  existing: ExistingConfig | null;
}

function writeConfigYaml(path: string, args: ConfigWriteArgs): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const obj: Record<string, unknown> = {
    owner: { name: args.owner_name, timezone: args.timezone },
    assistant: { name: args.assistant_name },
    tools: { allow_dangerous: args.allow_dangerous },
    google: { enabled: args.google_enabled },
    pii: { precommit_hook: args.precommit_hook },
  };
  // Preserve any existing sections the wizard doesn't manage.
  if (args.existing) {
    for (const [k, v] of Object.entries(args.existing)) {
      if (!(k in obj)) obj[k] = v;
    }
  }
  const header = [
    "# claude-pmax-harness — runtime config",
    "# Generated/updated by `harness setup`. Schema: src/config/schema.ts.",
    "# Re-running `harness setup` pre-fills from this file; existing fields",
    "# not surfaced by the wizard are preserved.",
    "",
  ].join("\n");
  writeFileSync(path, header + yaml.dump(obj, { noRefs: true, sortKeys: false }));
}

function runInstallMempalace(projectRoot: string): boolean {
  const script = resolve(projectRoot, "scripts", "install-mempalace.sh");
  if (!existsSync(script)) {
    logger.warn({ script }, "[wizard] install-mempalace.sh not found");
    return false;
  }
  try {
    execFileSync("bash", [script], {
      stdio: "inherit",
      env: {
        ...process.env,
        HARNESS_DATA_DIR:
          process.env.HARNESS_DATA_DIR ??
          resolve(homedir(), ".claude-pmax-harness"),
      },
    });
    return true;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[wizard] MemPalace install failed (non-fatal; user can run scripts/install-mempalace.sh manually)",
    );
    return false;
  }
}

function printSummary(args: {
  personalDir: string;
  envPath: string;
  rendered: RenderReport;
  cronSeed: RenderReport;
  installed_hook: boolean;
  mempalace_install_ok?: boolean;
}): void {
  console.log("");
  console.log("Setup complete.");
  console.log("-".repeat(60));
  console.log(`  personal/   ${args.personalDir}`);
  console.log(`  .env        ${args.envPath} (chmod 600)`);
  console.log(
    `  templates   ${args.rendered.written.length} written, ${args.rendered.skipped.length} skipped${args.rendered.backed_up.length ? `, ${args.rendered.backed_up.length} backed up` : ""}`,
  );
  console.log(
    `  cron        ${args.cronSeed.written.length} default(s) seeded, ${args.cronSeed.skipped.length} preserved`,
  );
  console.log(`  pre-commit  ${args.installed_hook ? "installed" : "skipped"}`);
  if (args.mempalace_install_ok !== undefined) {
    console.log(`  mempalace   ${args.mempalace_install_ok ? "installed" : "FAILED — run scripts/install-mempalace.sh manually"}`);
  }
  console.log("");
  console.log("Next steps:");
  console.log("  - Edit personal/wiki/identity.md and personal/wiki/principles.md");
  console.log("  - Start the bot: pm2 start ecosystem.config.cjs (or `harness bot` foreground)");
  console.log("  - See `harness --help` for the full CLI surface");
  console.log("");
}
