// Cron job loader — reads personal/cron/*.md files, parses YAML frontmatter,
// validates against the §13 schema, returns CronJob[]. Logs + skips malformed
// files rather than throwing — one broken job shouldn't take down the whole
// scheduler.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import matter from "gray-matter";
import { logger } from "../lib/logger.js";
import { ConfigError } from "../lib/errors.js";
import {
  CronFrontmatterSchema,
  type CronJob,
} from "./types.js";

export interface LoadCronJobsOptions {
  /** personal/cron/ or examples/cron/. */
  cronDir: string;
  /** Default timezone applied when a job's frontmatter omits one. */
  defaultTimezone: string;
}

export interface LoadResult {
  jobs: CronJob[];
  errors: Array<{ path: string; reason: string }>;
}

export function loadCronJobs(opts: LoadCronJobsOptions): LoadResult {
  const out: CronJob[] = [];
  const errors: Array<{ path: string; reason: string }> = [];

  if (!existsSync(opts.cronDir)) {
    return { jobs: [], errors: [] };
  }
  if (!statSync(opts.cronDir).isDirectory()) {
    throw new ConfigError(`cron dir is not a directory: ${opts.cronDir}`);
  }

  for (const entry of readdirSync(opts.cronDir)) {
    if (entry.startsWith(".") || !entry.endsWith(".md")) continue;
    const path = resolve(opts.cronDir, entry);
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (err) {
      errors.push({ path, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    let parsedFm: matter.GrayMatterFile<string>;
    try {
      parsedFm = matter(raw);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push({ path, reason: `frontmatter parse: ${reason}` });
      continue;
    }
    const validated = CronFrontmatterSchema.safeParse(parsedFm.data);
    if (!validated.success) {
      const reason = validated.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      errors.push({ path, reason: `schema: ${reason}` });
      logger.warn({ path, reason }, "[cron-loader] skipped invalid job");
      continue;
    }
    const instruction = parsedFm.content.trim();
    if (!instruction) {
      errors.push({ path, reason: "missing instruction body" });
      continue;
    }
    out.push({
      ...validated.data,
      timezone: validated.data.timezone ?? opts.defaultTimezone,
      instruction,
      source_path: path,
    });
  }

  // Detect duplicate ids — only the first wins; rest are errors.
  const seen = new Map<string, string>();
  const deduped: CronJob[] = [];
  for (const job of out) {
    const existing = seen.get(job.id);
    if (existing) {
      errors.push({
        path: job.source_path,
        reason: `duplicate id "${job.id}" — already defined in ${existing}`,
      });
      continue;
    }
    seen.set(job.id, job.source_path);
    deduped.push(job);
  }

  return { jobs: deduped, errors };
}
