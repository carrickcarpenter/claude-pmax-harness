// `harness pii-check` + `harness pii-check --staged` per docs/architecture.md
// §18.1 + §3. Reports category counts + file:line locations, never the matched
// values themselves.

import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig } from "../../config/load.js";
import { ConfigError, EXIT_CODES } from "../../lib/errors.js";
import { scanForPii, scanFiles, formatReport } from "../../pii/scanner.js";
import {
  installHook,
  uninstallHook,
  isInstalled,
} from "../../pii/precommit.js";

export interface PiiCheckOptions {
  projectRoot: string;
  staged?: boolean;
  installHook?: boolean;
  uninstallHook?: boolean;
}

export async function runPiiCheck(opts: PiiCheckOptions): Promise<number> {
  if (opts.installHook) {
    const result = installHook(opts.projectRoot);
    if (!result.installed) {
      console.error(`pre-commit hook install failed: ${result.reason}`);
      return EXIT_CODES.USER_ERROR;
    }
    console.log(`Installed pre-commit hook at ${result.path}`);
    if (result.backed_up) {
      console.log(`  (previous hook backed up to ${result.backed_up})`);
    }
    if (result.reason) console.log(`  ${result.reason}`);
    return EXIT_CODES.SUCCESS;
  }

  if (opts.uninstallHook) {
    const result = uninstallHook(opts.projectRoot);
    if (!result.removed) {
      console.error(`pre-commit hook uninstall failed: ${result.reason}`);
      return EXIT_CODES.USER_ERROR;
    }
    console.log(`Removed pre-commit hook at ${result.path}`);
    return EXIT_CODES.SUCCESS;
  }

  // Load config to get pii_check_categories — but allow scan even if
  // personal/config.yaml isn't yet generated (use defaults from schema).
  let categories;
  try {
    const loaded = loadConfig({ projectRoot: opts.projectRoot });
    categories = loaded.config?.pii.pii_check_categories;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    categories = undefined;
  }

  if (opts.staged) {
    const stagedFiles = listStagedFiles(opts.projectRoot);
    if (stagedFiles.length === 0) {
      console.log("No files staged for commit — nothing to scan.");
      return EXIT_CODES.SUCCESS;
    }
    // For --staged, scan files OUTSIDE personal/ per §18.1 #4
    // (warns when staged files outside personal/ contain category-shaped strings).
    const filesToScan = stagedFiles.filter((p) => !isInsidePersonal(p, opts.projectRoot));
    if (filesToScan.length === 0) {
      console.log(
        `All ${stagedFiles.length} staged file(s) are inside personal/ — nothing to warn on.`,
      );
      return EXIT_CODES.SUCCESS;
    }
    const report = scanFiles(filesToScan, { categories, root: opts.projectRoot });
    const hookActive = isInstalled(opts.projectRoot);
    console.log(formatReport(report));
    if (report.files_with_findings > 0) {
      console.error(
        `\nPII detected in staged files OUTSIDE personal/. Move sensitive content into personal/ (gitignored) or remove it before committing.`,
      );
      // Block the commit when the hook is active; otherwise exit cleanly with a warning.
      return hookActive ? EXIT_CODES.USER_ERROR : EXIT_CODES.SUCCESS;
    }
    return EXIT_CODES.SUCCESS;
  }

  // Full scan of personal/
  const personalDir = resolve(opts.projectRoot, "personal");
  if (!existsSync(personalDir)) {
    console.log(`personal/ not found at ${personalDir}. Run \`harness setup\` first.`);
    return EXIT_CODES.SUCCESS;
  }
  const report = scanForPii({ root: personalDir, categories });
  console.log(formatReport(report));
  return EXIT_CODES.SUCCESS;
}

function listStagedFiles(projectRoot: string): string[] {
  try {
    const out = execSync("git diff --cached --name-only --diff-filter=ACM", {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    if (!out) return [];
    return out.split("\n").map((f) => resolve(projectRoot, f));
  } catch {
    return [];
  }
}

function isInsidePersonal(absPath: string, projectRoot: string): boolean {
  const personalRoot = resolve(projectRoot, "personal");
  return absPath === personalRoot || absPath.startsWith(personalRoot + "/");
}
