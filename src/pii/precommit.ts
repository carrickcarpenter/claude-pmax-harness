// Pre-commit hook installer per docs/architecture.md §18.1 #4.
//
// Approach: copy a file into .git/hooks/pre-commit (visible, easy to inspect,
// easy to remove). Alternative considered (git config core.hooksPath) is
// cleaner but invisible to users. The file-copy approach matches the §15
// open-question we resolved by choosing it.
//
// The hook calls `harness pii-check --staged` against the git-staged-but-not-
// yet-committed file list. Non-zero exit blocks the commit.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";

export const HOOK_NAME = "pre-commit";
export const HOOK_MARKER = "# claude-pmax-harness pii pre-commit hook (v1)";

// The hook tries two invocation paths before giving up, so it works in
// both global-install setups (npm install -g / npm link) and plain
// 'npm install'-only clones. Without the npm fallback the hook silently
// skipped in any clone where 'harness' wasn't on PATH — a false sense
// of safety. The 'harness pii-check --staged' literal must remain in
// the script body; test/pii.test.ts asserts on it.
export const HOOK_SCRIPT = `#!/usr/bin/env bash
${HOOK_MARKER}
# Runs the PII check against files staged for commit. Non-zero exit
# blocks the commit. To disable, delete this file or run
# 'harness pii-check --uninstall-hook'.
#
# Tries two invocation paths so the hook works whether or not the
# 'harness' CLI is globally on PATH:
#   1. 'harness pii-check --staged' (works if installed via 'npm link'
#      or 'npm install -g')
#   2. 'npm --prefix <repo-root> run -s harness -- pii-check --staged'
#      (works in any clone where 'npm install' has been run)
# If neither is usable, the hook skips with a warning rather than
# blocking the commit.
set -e
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"

if command -v harness >/dev/null 2>&1; then
  exec harness pii-check --staged
fi

if [ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT/node_modules" ] && command -v npm >/dev/null 2>&1; then
  exec npm --prefix "$REPO_ROOT" run -s harness -- pii-check --staged
fi

echo "[pre-commit] cannot run harness PII check ('harness' not on PATH and 'npm run harness' not usable); skipping" >&2
echo "[pre-commit] (fix: run 'npm install' in the repo root, or 'npm link' to expose 'harness' on PATH)" >&2
exit 0
`;

export function hookPathFor(repoRoot: string): string {
  return resolve(repoRoot, ".git", "hooks", HOOK_NAME);
}

export function isInstalled(repoRoot: string): boolean {
  const path = hookPathFor(repoRoot);
  if (!existsSync(path)) return false;
  const contents = readFileSync(path, "utf-8");
  return contents.includes(HOOK_MARKER);
}

export interface InstallResult {
  installed: boolean;
  path: string;
  /** True if an existing pre-commit hook (not ours) was present and we backed it up. */
  backed_up?: string;
  reason?: string;
}

export function installHook(repoRoot: string): InstallResult {
  const gitDir = resolve(repoRoot, ".git");
  if (!existsSync(gitDir)) {
    return {
      installed: false,
      path: hookPathFor(repoRoot),
      reason: "not a git repo (.git/ not found)",
    };
  }
  const hooksDir = resolve(gitDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const path = hookPathFor(repoRoot);

  let backed_up: string | undefined;
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf-8");
    if (existing.includes(HOOK_MARKER)) {
      // Already ours — idempotent re-install (refresh).
      writeFileSync(path, HOOK_SCRIPT);
      chmodSync(path, 0o755);
      return { installed: true, path, reason: "refreshed existing harness hook" };
    }
    // Foreign hook — back it up.
    backed_up = `${path}.backup-${Date.now()}`;
    writeFileSync(backed_up, existing);
  }

  writeFileSync(path, HOOK_SCRIPT);
  chmodSync(path, 0o755);
  return { installed: true, path, backed_up };
}

export function uninstallHook(repoRoot: string): {
  removed: boolean;
  path: string;
  reason?: string;
} {
  const path = hookPathFor(repoRoot);
  if (!existsSync(path)) {
    return { removed: false, path, reason: "no hook file present" };
  }
  const contents = readFileSync(path, "utf-8");
  if (!contents.includes(HOOK_MARKER)) {
    return {
      removed: false,
      path,
      reason: "pre-commit hook exists but isn't ours — refusing to remove. Inspect manually.",
    };
  }
  try {
    unlinkSync(path);
    return { removed: true, path };
  } catch (err) {
    return {
      removed: false,
      path,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
