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

export const HOOK_SCRIPT = `#!/usr/bin/env bash
${HOOK_MARKER}
# Runs \`harness pii-check --staged\` against the list of files staged for
# commit. Non-zero exit blocks the commit. To disable, either delete this
# file or run \`harness pii-check --uninstall-hook\`.
set -e
if ! command -v harness >/dev/null 2>&1; then
  echo "[pre-commit] harness CLI not on PATH; skipping PII check" >&2
  exit 0
fi
harness pii-check --staged
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
