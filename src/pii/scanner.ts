// PII scanner per docs/architecture.md §18.1.
//
// Walks a directory (or a specific file list), reads every file, and reports
// the COUNT of matches per PiiCategory per file. Does NOT include the matched
// values in the report — only counts + line numbers. This is the documented
// design: tell the user what categories of risk are present, not surface
// the secrets themselves.

import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { CATEGORIES, type PiiCategory } from "./patterns.js";

export interface FileFinding {
  /** Relative path from the scan root. */
  path: string;
  /** Category → list of line numbers (1-indexed) where matches occurred. */
  matches: Partial<Record<PiiCategory, number[]>>;
  /** Total hit count across all categories. */
  total: number;
}

export interface ScanReport {
  /** Total files scanned (including those with zero findings). */
  files_scanned: number;
  /** Files that had at least one finding. */
  files_with_findings: number;
  /** Aggregate count per category across all files. */
  category_totals: Partial<Record<PiiCategory, number>>;
  /** Per-file detail; only files with findings included. */
  findings: FileFinding[];
}

export interface ScanOptions {
  /** Directory or file to scan. */
  root: string;
  /** Categories to scan for. Empty = all categories. */
  categories?: PiiCategory[];
  /** File extensions to scan. Default: text-like files. */
  extensions?: string[];
  /** Path patterns to skip (substring match against relative path). */
  exclude?: string[];
  /** Max file size to scan in bytes (skip larger files). Default 1 MB. */
  maxFileSize?: number;
}

const DEFAULT_EXTENSIONS = [
  ".md",
  ".txt",
  ".yaml",
  ".yml",
  ".json",
  ".js",
  ".ts",
  ".tsx",
  ".py",
  ".sh",
  ".env",
];

const DEFAULT_EXCLUDES = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  "venv/",
  ".vscode/",
  ".idea/",
  "coverage/",
];

const DEFAULT_MAX_SIZE = 1024 * 1024; // 1 MB

export function scanForPii(opts: ScanOptions): ScanReport {
  const root = resolve(opts.root);
  const cats = opts.categories?.length
    ? opts.categories
    : (Object.keys(CATEGORIES) as PiiCategory[]);
  const exts = new Set(opts.extensions ?? DEFAULT_EXTENSIONS);
  const excludes = opts.exclude ?? DEFAULT_EXCLUDES;
  const maxSize = opts.maxFileSize ?? DEFAULT_MAX_SIZE;

  const report: ScanReport = {
    files_scanned: 0,
    files_with_findings: 0,
    category_totals: {},
    findings: [],
  };

  if (!existsSync(root)) return report;

  const files = collectFiles(root, exts, excludes, maxSize);
  for (const filePath of files) {
    report.files_scanned += 1;
    const finding = scanFile(filePath, cats, root);
    if (finding.total > 0) {
      report.findings.push(finding);
      report.files_with_findings += 1;
      for (const [cat, lines] of Object.entries(finding.matches)) {
        const c = cat as PiiCategory;
        report.category_totals[c] = (report.category_totals[c] ?? 0) + (lines?.length ?? 0);
      }
    }
  }

  return report;
}

/** Scan a specific list of file paths (used by --staged). */
export function scanFiles(
  files: string[],
  opts: { categories?: PiiCategory[]; root?: string } = {},
): ScanReport {
  const cats = opts.categories?.length
    ? opts.categories
    : (Object.keys(CATEGORIES) as PiiCategory[]);
  const root = opts.root ? resolve(opts.root) : process.cwd();

  const report: ScanReport = {
    files_scanned: 0,
    files_with_findings: 0,
    category_totals: {},
    findings: [],
  };

  for (const filePath of files) {
    if (!existsSync(filePath)) continue;
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      if (stat.size > DEFAULT_MAX_SIZE) continue;
    } catch {
      continue;
    }
    report.files_scanned += 1;
    const finding = scanFile(filePath, cats, root);
    if (finding.total > 0) {
      report.findings.push(finding);
      report.files_with_findings += 1;
      for (const [cat, lines] of Object.entries(finding.matches)) {
        const c = cat as PiiCategory;
        report.category_totals[c] = (report.category_totals[c] ?? 0) + (lines?.length ?? 0);
      }
    }
  }

  return report;
}

function collectFiles(
  root: string,
  exts: Set<string>,
  excludes: string[],
  maxSize: number,
): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = resolve(dir, entry.name);
      const rel = relative(root, abs);
      if (excludes.some((ex) => rel.includes(ex))) continue;
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        if (!exts.has(extOf(entry.name))) continue;
        try {
          const stat = statSync(abs);
          if (stat.size > maxSize) continue;
        } catch {
          continue;
        }
        out.push(abs);
      }
    }
  }
  return out;
}

function scanFile(absPath: string, cats: PiiCategory[], root: string): FileFinding {
  const rel = relative(root, absPath) || absPath;
  const finding: FileFinding = { path: rel, matches: {}, total: 0 };
  let content: string;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch {
    return finding;
  }
  const lines = content.split("\n");
  for (const cat of cats) {
    const handler = CATEGORIES[cat];
    const linesWithHits: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const hits = handler.find(line);
      if (hits.length > 0) linesWithHits.push(i + 1);
    }
    if (linesWithHits.length > 0) {
      finding.matches[cat] = linesWithHits;
      finding.total += linesWithHits.length;
    }
  }
  return finding;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

/**
 * Format a ScanReport as a human-readable string for terminal output.
 * Lists categories + counts + files + line numbers. Never includes the
 * matched values themselves.
 */
export function formatReport(report: ScanReport): string {
  if (report.files_with_findings === 0) {
    return `PII scan clean — ${report.files_scanned} file(s) scanned, 0 findings.`;
  }
  const lines: string[] = [];
  lines.push(
    `PII scan: ${report.files_with_findings}/${report.files_scanned} file(s) had findings.`,
  );
  lines.push("");
  lines.push("Category totals:");
  for (const [cat, count] of Object.entries(report.category_totals)) {
    lines.push(`  ${cat.padEnd(14)} ${count}`);
  }
  lines.push("");
  lines.push("By file:");
  for (const f of report.findings) {
    lines.push(`  ${f.path}  (${f.total} hit${f.total === 1 ? "" : "s"})`);
    for (const [cat, lns] of Object.entries(f.matches)) {
      if (lns && lns.length > 0) {
        const preview = lns.slice(0, 10).join(", ");
        const more = lns.length > 10 ? `, +${lns.length - 10} more` : "";
        lines.push(`    ${cat}: line${lns.length === 1 ? "" : "s"} ${preview}${more}`);
      }
    }
  }
  return lines.join("\n");
}
