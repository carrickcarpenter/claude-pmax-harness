import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import { runWizard } from "../src/setup/wizard.js";
import { renderTemplates, seedCronDefaults } from "../src/setup/templates.js";
import {
  ask,
  askYesNo,
  validateTimezone,
  validateTelegramToken,
  validateChatId,
  type Prompter,
} from "../src/setup/prompts.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "setup-test-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── prompts ──────────────────────────────────────────────────────────────

function scriptedPrompter(answers: string[]): Prompter {
  let i = 0;
  return async () => {
    if (i >= answers.length) throw new Error(`no more scripted answers (asked ${i + 1})`);
    return answers[i++]!;
  };
}

describe("prompts: ask + validators", () => {
  test("returns the typed value (no default)", async () => {
    const ans = await ask(scriptedPrompter(["jane"]), "name?");
    expect(ans).toBe("jane");
  });

  test("uses default on empty input", async () => {
    const ans = await ask(scriptedPrompter([""]), "name?", { default: "alice" });
    expect(ans).toBe("alice");
  });

  test("re-prompts on validation failure", async () => {
    const ans = await ask(scriptedPrompter(["x", "valid-value"]), "name?", {
      validate: (s) => (s.length < 5 ? "too short" : null),
    });
    expect(ans).toBe("valid-value");
  });

  test("preset bypasses prompting", async () => {
    let called = false;
    const ans = await ask(
      async () => {
        called = true;
        return "ignored";
      },
      "?",
      { preset: "fixed" },
    );
    expect(ans).toBe("fixed");
    expect(called).toBe(false);
  });

  test("validateTimezone accepts valid + rejects invalid", () => {
    const v = validateTimezone();
    expect(v("America/New_York")).toBeNull();
    expect(v("Etc/UTC")).toBeNull();
    expect(v("Not/A/Real/Zone")).not.toBeNull();
  });

  test("validateTelegramToken accepts canonical shape only", () => {
    const v = validateTelegramToken();
    expect(v("123456789:AAEhBOweik6ad6PsVgwwMjbGfb9HZyDD123")).toBeNull();
    expect(v("not-a-token")).not.toBeNull();
    expect(v("123:short")).not.toBeNull();
  });

  test("validateChatId accepts positive + negative integers only", () => {
    const v = validateChatId();
    expect(v("12345")).toBeNull();
    expect(v("-1001234567890")).toBeNull();
    expect(v("abc")).not.toBeNull();
    expect(v("123.4")).not.toBeNull();
  });
});

describe("prompts: askYesNo", () => {
  test("y/yes return true; n/no return false", async () => {
    expect(await askYesNo(scriptedPrompter(["y"]), "?")).toBe(true);
    expect(await askYesNo(scriptedPrompter(["yes"]), "?")).toBe(true);
    expect(await askYesNo(scriptedPrompter(["n"]), "?")).toBe(false);
    expect(await askYesNo(scriptedPrompter(["no"]), "?")).toBe(false);
  });

  test("empty input uses default", async () => {
    expect(await askYesNo(scriptedPrompter([""]), "?", { default: true })).toBe(true);
    expect(await askYesNo(scriptedPrompter([""]), "?", { default: false })).toBe(false);
  });

  test("preset bypasses", async () => {
    expect(await askYesNo(scriptedPrompter([]), "?", { preset: true })).toBe(true);
    expect(await askYesNo(scriptedPrompter([]), "?", { preset: false })).toBe(false);
  });
});

// ── templates ────────────────────────────────────────────────────────────

describe("renderTemplates", () => {
  function seedTemplates(dir: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, "CLAUDE.md.template"),
      "I am {{assistant_name}}, for {{owner.name}} in {{owner.timezone}}.",
    );
    mkdirSync(resolve(dir, "wiki"), { recursive: true });
    writeFileSync(
      resolve(dir, "wiki", "index.md.template"),
      "# {{owner.name}}'s wiki index",
    );
    writeFileSync(resolve(dir, "wiki", "WIKI.md"), "Wiki schema (no placeholders).");
  }

  test("renders *.template files; copies non-template files as-is", () => {
    const tmplDir = resolve(tmpRoot, "templates");
    const personalDir = resolve(tmpRoot, "personal");
    seedTemplates(tmplDir);
    const report = renderTemplates({
      templatesDir: tmplDir,
      personalDir,
      view: { assistant_name: "Sage", owner: { name: "Alice", timezone: "America/New_York" } },
    });
    expect(report.written).toEqual(
      expect.arrayContaining(["CLAUDE.md", "wiki/index.md", "wiki/WIKI.md"]),
    );
    const claude = readFileSync(resolve(personalDir, "CLAUDE.md"), "utf-8");
    expect(claude).toContain("I am Sage, for Alice in America/New_York.");
    const wiki = readFileSync(resolve(personalDir, "wiki", "WIKI.md"), "utf-8");
    expect(wiki).toBe("Wiki schema (no placeholders).");
  });

  test("skips existing files by default (idempotent)", () => {
    const tmplDir = resolve(tmpRoot, "templates");
    const personalDir = resolve(tmpRoot, "personal");
    seedTemplates(tmplDir);
    // First pass writes
    renderTemplates({
      templatesDir: tmplDir,
      personalDir,
      view: { assistant_name: "Sage", owner: { name: "Alice", timezone: "America/New_York" } },
    });
    // Modify the rendered file
    writeFileSync(resolve(personalDir, "CLAUDE.md"), "EDITED BY USER");
    // Second pass should skip
    const second = renderTemplates({
      templatesDir: tmplDir,
      personalDir,
      view: { assistant_name: "Sage", owner: { name: "Alice", timezone: "America/New_York" } },
    });
    expect(second.skipped).toContain("CLAUDE.md");
    expect(second.written).not.toContain("CLAUDE.md");
    expect(readFileSync(resolve(personalDir, "CLAUDE.md"), "utf-8")).toBe(
      "EDITED BY USER",
    );
  });

  test("force=true overwrites with .bak sidecar", () => {
    const tmplDir = resolve(tmpRoot, "templates");
    const personalDir = resolve(tmpRoot, "personal");
    seedTemplates(tmplDir);
    renderTemplates({
      templatesDir: tmplDir,
      personalDir,
      view: { assistant_name: "Sage", owner: { name: "Alice", timezone: "Etc/UTC" } },
    });
    writeFileSync(resolve(personalDir, "CLAUDE.md"), "EDITED");
    const report = renderTemplates({
      templatesDir: tmplDir,
      personalDir,
      view: { assistant_name: "Sage", owner: { name: "Bob", timezone: "Etc/UTC" } },
      force: true,
    });
    expect(report.written).toContain("CLAUDE.md");
    expect(report.backed_up.length).toBeGreaterThanOrEqual(1);
    const rendered = readFileSync(resolve(personalDir, "CLAUDE.md"), "utf-8");
    expect(rendered).toContain("for Bob");
    // .bak sidecar contains the previous content
    const bakName = report.backed_up.find((p) => p.startsWith("CLAUDE.md.bak-"));
    expect(bakName).toBeDefined();
    const bakContent = readFileSync(resolve(personalDir, bakName!), "utf-8");
    expect(bakContent).toBe("EDITED");
  });
});

describe("seedCronDefaults", () => {
  test("copies templates/cron/* when personal/cron/ is empty", () => {
    const tmplCronDir = resolve(tmpRoot, "templates", "cron");
    const personalCronDir = resolve(tmpRoot, "personal", "cron");
    mkdirSync(tmplCronDir, { recursive: true });
    writeFileSync(resolve(tmplCronDir, "morning.md"), "fake morning job");
    writeFileSync(resolve(tmplCronDir, "weekly.md"), "fake weekly job");
    const report = seedCronDefaults({ templatesCronDir: tmplCronDir, personalCronDir });
    expect(report.written.sort()).toEqual(["morning.md", "weekly.md"]);
    expect(readFileSync(resolve(personalCronDir, "morning.md"), "utf-8")).toBe(
      "fake morning job",
    );
  });

  test("does NOT copy when personal/cron/ has existing jobs (without force)", () => {
    const tmplCronDir = resolve(tmpRoot, "templates", "cron");
    const personalCronDir = resolve(tmpRoot, "personal", "cron");
    mkdirSync(tmplCronDir, { recursive: true });
    mkdirSync(personalCronDir, { recursive: true });
    writeFileSync(resolve(tmplCronDir, "new.md"), "from template");
    writeFileSync(resolve(personalCronDir, "user-job.md"), "user content");
    const report = seedCronDefaults({ templatesCronDir: tmplCronDir, personalCronDir });
    expect(report.written).toEqual([]);
    expect(report.skipped).toContain("user-job.md");
    // Template not copied
    expect(existsSync(resolve(personalCronDir, "new.md"))).toBe(false);
  });
});

// ── wizard (end-to-end with stub prompter + skipped install/doctor) ─────

describe("runWizard (interactive flow with scripted answers)", () => {
  function setupProjectWithTemplates(): { projectRoot: string } {
    const projectRoot = tmpRoot;
    // Copy the real templates from the repo so the wizard has something to render.
    const repoTemplates = resolve(
      process.cwd(),
      "templates",
    );
    const dstTemplates = resolve(projectRoot, "templates");
    copyDirSync(repoTemplates, dstTemplates);
    return { projectRoot };
  }

  test("fresh setup: writes .env, config.yaml, and renders templates", async () => {
    const { projectRoot } = setupProjectWithTemplates();
    const prompter = scriptedPrompter([
      "n",                                                  // privacy gate
      "Jane Smith",                                         // owner name
      "America/Los_Angeles",                                // timezone
      "Sage",                                               // assistant name
      "123456789:AAEhBOweik6ad6PsVgwwMjbGfb9HZyDD123",     // telegram token
      "987654321",                                          // chat id
      "n",                                                  // google
      "y",                                                  // precommit hook
      "y",                                                  // allow dangerous
    ]);
    const result = await runWizard({
      projectRoot,
      prompter,
      skipMemPalaceInstall: true,
      skipDoctor: true,
    });
    expect(existsSync(result.env_path)).toBe(true);
    expect(existsSync(result.config_path)).toBe(true);
    const env = readFileSync(result.env_path, "utf-8");
    expect(env).toContain("TELEGRAM_BOT_TOKEN=123456789:");
    expect(env).toContain("TELEGRAM_OWNER_CHAT_ID=987654321");
    const config = readFileSync(result.config_path, "utf-8");
    expect(config).toContain("name: Jane Smith");
    expect(config).toContain("timezone: America/Los_Angeles");
    expect(config).toContain("Sage");
    // Templates rendered
    const claudeMd = readFileSync(resolve(projectRoot, "personal", "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("Sage");
    expect(claudeMd).toContain("Jane Smith");
    expect(claudeMd).toContain("America/Los_Angeles");
  });

  test("re-run pre-fills from existing config and preserves edits", async () => {
    const { projectRoot } = setupProjectWithTemplates();
    // First run
    await runWizard({
      projectRoot,
      prompter: scriptedPrompter([
        "n", "Original", "America/New_York", "Sage",
        "111111111:AAEhBOweik6ad6PsVgwwMjbGfb9HZyDD123", "1",
        "n", "n", "y",
      ]),
      skipMemPalaceInstall: true,
      skipDoctor: true,
    });
    // User edits the rendered CLAUDE.md
    writeFileSync(resolve(projectRoot, "personal", "CLAUDE.md"), "MY EDITS");
    // Second run, hit enter on every prompt to take defaults
    const prompter = scriptedPrompter([
      "n", "", "", "", "", "", "n", "n", "y",
    ]);
    const result = await runWizard({
      projectRoot,
      prompter,
      skipMemPalaceInstall: true,
      skipDoctor: true,
    });
    // Pre-fill worked — config still has "Original"
    const config = readFileSync(result.config_path, "utf-8");
    expect(config).toContain("name: Original");
    // Edited CLAUDE.md preserved (skipped due to idempotency)
    expect(readFileSync(resolve(projectRoot, "personal", "CLAUDE.md"), "utf-8")).toBe(
      "MY EDITS",
    );
  });

  test("non-interactive mode requires presets and writes files without prompting", async () => {
    const { projectRoot } = setupProjectWithTemplates();
    let calls = 0;
    const failingPrompter: Prompter = async () => {
      calls += 1;
      throw new Error("should not prompt in non-interactive mode");
    };
    const result = await runWizard({
      projectRoot,
      prompter: failingPrompter,
      nonInteractive: true,
      preset: {
        owner_name: "Jane",
        timezone: "Etc/UTC",
        assistant_name: "Sage",
        telegram_token: "999888777:AAEhBOweik6ad6PsVgwwMjbGfb9HZyDD123",
        telegram_chat_id: "42",
        google_enabled: false,
        precommit_hook: false,
        allow_dangerous: true,
      },
      skipMemPalaceInstall: true,
      skipDoctor: true,
    });
    expect(calls).toBe(0);
    expect(existsSync(result.config_path)).toBe(true);
  });

  test(".env permissions are set to 600 on POSIX", async () => {
    const { projectRoot } = setupProjectWithTemplates();
    await runWizard({
      projectRoot,
      prompter: scriptedPrompter([
        "n", "X", "Etc/UTC", "Y",
        "111111111:AAEhBOweik6ad6PsVgwwMjbGfb9HZyDD123", "1",
        "n", "n", "y",
      ]),
      skipMemPalaceInstall: true,
      skipDoctor: true,
    });
    const fs = require("node:fs") as typeof import("node:fs");
    const mode = fs.statSync(resolve(projectRoot, ".env")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

function copyDirSync(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = resolve(src, entry.name);
    const dstPath = resolve(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, dstPath);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, dstPath);
    }
  }
}
