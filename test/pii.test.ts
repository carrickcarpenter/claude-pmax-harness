import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { CATEGORIES } from "../src/pii/patterns.js";
import { scanForPii, scanFiles, formatReport } from "../src/pii/scanner.js";
import {
  installHook,
  uninstallHook,
  isInstalled,
  HOOK_MARKER,
  hookPathFor,
} from "../src/pii/precommit.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "pii-test-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── patterns ─────────────────────────────────────────────────────────────

describe("PII pattern detectors", () => {
  test("email detector hits real-looking addresses", () => {
    expect(CATEGORIES.email.find("contact me at jane@acme.com please")).toEqual([
      "jane@acme.com",
    ]);
    expect(CATEGORIES.email.find("alice.smith@company.co.uk")).toEqual([
      "alice.smith@company.co.uk",
    ]);
  });

  test("email detector ignores common placeholder domains", () => {
    expect(CATEGORIES.email.find("test@example.com")).toEqual([]);
    expect(CATEGORIES.email.find("you@example.org")).toEqual([]);
    expect(CATEGORIES.email.find("foo@localhost")).toEqual([]);
  });

  test("phone detector hits NA-style numbers", () => {
    expect(CATEGORIES.phone.find("call me at 555-867-5309")).toEqual([
      "555-867-5309",
    ]);
    expect(CATEGORIES.phone.find("(704) 555-1234")).toEqual(["(704) 555-1234"]);
    expect(CATEGORIES.phone.find("+1-704-555-1234").length).toBeGreaterThan(0);
  });

  test("phone detector ignores 4-digit-only sequences", () => {
    expect(CATEGORIES.phone.find("year 2026 was great")).toEqual([]);
  });

  test("address detector hits street + suffix", () => {
    expect(
      CATEGORIES.address.find("I live at 123 Main Street next to the park"),
    ).toEqual(["123 Main Street"]);
    expect(
      CATEGORIES.address.find("4567 Oak Ridge Avenue").length,
    ).toBeGreaterThan(0);
  });

  test("address detector ignores prose without street suffix", () => {
    expect(CATEGORIES.address.find("123 reasons to love this place")).toEqual(
      [],
    );
  });

  test("calendar_id detector hits Google Calendar IDs", () => {
    expect(
      CATEGORIES.calendar_id.find(
        "family cal: abcdef123456@group.calendar.google.com is shared",
      ),
    ).toEqual(["abcdef123456@group.calendar.google.com"]);
  });

  test("financial detector hits SSN-shaped and credit-card-shaped", () => {
    expect(CATEGORIES.financial.find("SSN: 123-45-6789")).toEqual([
      "123-45-6789",
    ]);
    expect(
      CATEGORIES.financial.find("card 4111-1111-1111-1111 expires soon"),
    ).toEqual(["4111-1111-1111-1111"]);
  });
});

// ── scanner ──────────────────────────────────────────────────────────────

describe("scanForPii", () => {
  test("returns empty report for empty directory", () => {
    mkdirSync(resolve(tmpRoot, "empty"));
    const report = scanForPii({ root: resolve(tmpRoot, "empty") });
    expect(report.files_scanned).toBe(0);
    expect(report.files_with_findings).toBe(0);
    expect(report.findings).toEqual([]);
  });

  test("reports counts and line numbers, never the matched values", () => {
    writeFileSync(
      resolve(tmpRoot, "notes.md"),
      [
        "# Personal notes",
        "Email: jane@acme.com",
        "Phone: 555-867-5309",
        "",
        "Also jane@acme.com again",
      ].join("\n"),
    );
    const report = scanForPii({ root: tmpRoot });
    expect(report.files_with_findings).toBe(1);
    expect(report.findings[0]!.path).toBe("notes.md");
    expect(report.findings[0]!.matches.email).toEqual([2, 5]);
    expect(report.findings[0]!.matches.phone).toEqual([3]);
    expect(report.category_totals.email).toBe(2);
    expect(report.category_totals.phone).toBe(1);
    // The formatter must not contain the matched values themselves.
    const formatted = formatReport(report);
    expect(formatted).not.toContain("jane@acme.com");
    expect(formatted).not.toContain("555-867-5309");
    expect(formatted).toContain("email");
    expect(formatted).toContain("line");
  });

  test("only scans configured extensions", () => {
    writeFileSync(resolve(tmpRoot, "notes.md"), "Email: jane@acme.com");
    writeFileSync(resolve(tmpRoot, "binary.png"), "Email: jane@acme.com");
    const report = scanForPii({ root: tmpRoot });
    expect(report.findings.map((f) => f.path)).toEqual(["notes.md"]);
  });

  test("scopes to requested categories", () => {
    writeFileSync(
      resolve(tmpRoot, "mix.md"),
      "Email: jane@acme.com\nPhone: 555-867-5309",
    );
    const report = scanForPii({ root: tmpRoot, categories: ["email"] });
    expect(report.findings[0]!.matches.email).toBeDefined();
    expect(report.findings[0]!.matches.phone).toBeUndefined();
  });

  test("skips files in default-excluded paths (node_modules, .git, etc.)", () => {
    mkdirSync(resolve(tmpRoot, "node_modules", "pkg"), { recursive: true });
    writeFileSync(
      resolve(tmpRoot, "node_modules", "pkg", "x.md"),
      "Email: jane@acme.com",
    );
    mkdirSync(resolve(tmpRoot, ".git", "objects"), { recursive: true });
    writeFileSync(
      resolve(tmpRoot, ".git", "objects", "x.md"),
      "Email: jane@acme.com",
    );
    writeFileSync(resolve(tmpRoot, "kept.md"), "Email: jane@acme.com");
    const report = scanForPii({ root: tmpRoot });
    expect(report.findings.map((f) => f.path)).toEqual(["kept.md"]);
  });

  test("formatReport says clean when nothing found", () => {
    writeFileSync(resolve(tmpRoot, "clean.md"), "nothing sensitive here");
    const report = scanForPii({ root: tmpRoot });
    expect(formatReport(report)).toMatch(/clean/);
  });
});

describe("scanFiles (explicit list)", () => {
  test("scans only the files passed in", () => {
    writeFileSync(resolve(tmpRoot, "a.md"), "Email: jane@acme.com");
    writeFileSync(resolve(tmpRoot, "b.md"), "Phone: 555-867-5309");
    writeFileSync(resolve(tmpRoot, "ignored.md"), "Email: skip@acme.com");
    const report = scanFiles([
      resolve(tmpRoot, "a.md"),
      resolve(tmpRoot, "b.md"),
    ], { root: tmpRoot });
    expect(report.files_scanned).toBe(2);
    expect(new Set(report.findings.map((f) => f.path))).toEqual(
      new Set(["a.md", "b.md"]),
    );
  });

  test("silently skips non-existent paths", () => {
    writeFileSync(resolve(tmpRoot, "a.md"), "Email: jane@acme.com");
    const report = scanFiles([
      resolve(tmpRoot, "a.md"),
      resolve(tmpRoot, "missing.md"),
    ], { root: tmpRoot });
    expect(report.files_scanned).toBe(1);
  });
});

// ── precommit hook ──────────────────────────────────────────────────────

describe("pre-commit hook installer", () => {
  function makeRepo(): string {
    execSync(`git init -q "${tmpRoot}"`);
    return tmpRoot;
  }

  test("returns 'not a git repo' for a non-repo dir", () => {
    const result = installHook(tmpRoot);
    expect(result.installed).toBe(false);
    expect(result.reason).toMatch(/git/i);
  });

  test("installs a fresh hook file with our marker + executable bit", () => {
    const repo = makeRepo();
    const result = installHook(repo);
    expect(result.installed).toBe(true);
    expect(existsSync(result.path)).toBe(true);
    const contents = readFileSync(result.path, "utf-8");
    expect(contents).toContain(HOOK_MARKER);
    expect(contents).toContain("harness pii-check --staged");
    // Check executable bit set
    const st = require("node:fs").statSync(result.path);
    expect((st.mode & 0o100) !== 0).toBe(true);
  });

  test("hook script has both invocation paths so it works without 'harness' on PATH", () => {
    // Regression: earlier hook only tried 'harness' and silently skipped in any
    // clone that didn't have it globally installed — a false sense of safety.
    // It now also tries 'npm --prefix <repo> run -s harness --' as a fallback.
    const repo = makeRepo();
    const result = installHook(repo);
    const contents = readFileSync(result.path, "utf-8");
    expect(contents).toMatch(/command -v harness/);
    expect(contents).toMatch(/npm --prefix .* run -s harness --/);
    expect(contents).toMatch(/git rev-parse --show-toplevel/);
  });

  test("isInstalled returns true after install + false after uninstall", () => {
    const repo = makeRepo();
    expect(isInstalled(repo)).toBe(false);
    installHook(repo);
    expect(isInstalled(repo)).toBe(true);
    const result = uninstallHook(repo);
    expect(result.removed).toBe(true);
    expect(isInstalled(repo)).toBe(false);
  });

  test("backs up an existing foreign hook before installing ours", () => {
    const repo = makeRepo();
    const hookPath = hookPathFor(repo);
    mkdirSync(resolve(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(hookPath, "#!/bin/sh\n# someone else's hook\nexit 0\n");
    chmodSync(hookPath, 0o755);
    const result = installHook(repo);
    expect(result.installed).toBe(true);
    expect(result.backed_up).toBeDefined();
    expect(existsSync(result.backed_up!)).toBe(true);
    expect(readFileSync(result.backed_up!, "utf-8")).toContain(
      "someone else's hook",
    );
    // And our hook now lives at the original path
    expect(readFileSync(hookPath, "utf-8")).toContain(HOOK_MARKER);
  });

  test("uninstall refuses to remove a foreign hook", () => {
    const repo = makeRepo();
    const hookPath = hookPathFor(repo);
    mkdirSync(resolve(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(hookPath, "#!/bin/sh\n# someone else's hook\nexit 0\n");
    const result = uninstallHook(repo);
    expect(result.removed).toBe(false);
    expect(result.reason).toMatch(/isn't ours/);
    // foreign hook still there
    expect(readFileSync(hookPath, "utf-8")).toContain("someone else's hook");
  });

  test("idempotent: reinstall refreshes our existing hook in place", () => {
    const repo = makeRepo();
    installHook(repo);
    const result = installHook(repo);
    expect(result.installed).toBe(true);
    expect(result.reason).toMatch(/refreshed/);
  });
});
