// Mustache template rendering for the setup wizard.
//
// Walks templates/ tree. For each *.template file: render with Mustache
// against the supplied view object, write to personal/<same path minus
// .template>. For non-template files: copy as-is to personal/.
//
// Idempotent: by default, skips files that already exist in personal/.
// Pass force=true to overwrite (with .bak sidecar of the existing version).

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { resolve, dirname, relative } from "node:path";
import Mustache from "mustache";

// Templates render into local markdown/text files, not HTML — disable
// Mustache's default HTML-escape so `/` and `&` survive unmangled.
Mustache.escape = (s: string) => s;

export interface RenderOptions {
  templatesDir: string;
  personalDir: string;
  view: Record<string, unknown>;
  force?: boolean;
}

export interface RenderReport {
  written: string[];
  skipped: string[];
  backed_up: string[];
}

const TEMPLATE_EXT = ".template";

export function renderTemplates(opts: RenderOptions): RenderReport {
  const report: RenderReport = { written: [], skipped: [], backed_up: [] };
  if (!existsSync(opts.templatesDir)) return report;

  for (const abs of walkFiles(opts.templatesDir)) {
    const rel = relative(opts.templatesDir, abs);
    const isTemplate = rel.endsWith(TEMPLATE_EXT);
    const personalRel = isTemplate ? rel.slice(0, -TEMPLATE_EXT.length) : rel;
    const personalAbs = resolve(opts.personalDir, personalRel);

    if (existsSync(personalAbs) && !opts.force) {
      report.skipped.push(personalRel);
      continue;
    }

    mkdirSync(dirname(personalAbs), { recursive: true });

    if (existsSync(personalAbs) && opts.force) {
      const backup = `${personalAbs}.bak-${Date.now()}`;
      copyFileSync(personalAbs, backup);
      report.backed_up.push(relative(opts.personalDir, backup));
    }

    if (isTemplate) {
      const source = readFileSync(abs, "utf-8");
      const rendered = Mustache.render(source, opts.view);
      writeFileSync(personalAbs, rendered);
    } else {
      copyFileSync(abs, personalAbs);
    }
    report.written.push(personalRel);
  }

  return report;
}

/** Copy templates/cron/* into personal/cron/ but only if personal/cron/ is empty. */
export function seedCronDefaults(opts: {
  templatesCronDir: string;
  personalCronDir: string;
  force?: boolean;
}): RenderReport {
  const report: RenderReport = { written: [], skipped: [], backed_up: [] };
  if (!existsSync(opts.templatesCronDir)) return report;

  mkdirSync(opts.personalCronDir, { recursive: true });
  const existing = readdirSync(opts.personalCronDir).filter((f) =>
    f.endsWith(".md"),
  );
  if (existing.length > 0 && !opts.force) {
    return { written: [], skipped: existing, backed_up: [] };
  }

  for (const abs of walkFiles(opts.templatesCronDir)) {
    const rel = relative(opts.templatesCronDir, abs);
    const dest = resolve(opts.personalCronDir, rel);
    if (existsSync(dest) && !opts.force) {
      report.skipped.push(rel);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(dest) && opts.force) {
      const backup = `${dest}.bak-${Date.now()}`;
      copyFileSync(dest, backup);
      report.backed_up.push(relative(opts.personalCronDir, backup));
    }
    copyFileSync(abs, dest);
    report.written.push(rel);
  }
  return report;
}

function* walkFiles(dir: string): Generator<string> {
  const stack: string[] = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true }) as Dirent[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = resolve(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        try {
          if (statSync(abs).isFile()) yield abs;
        } catch {
          // skip
        }
      }
    }
  }
}
