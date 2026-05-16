// CronJob types per docs/architecture.md §13 (locked frontmatter shape) +
// §17.3 (per-job model assignment, timeout, persistent_session, delivery).

import { z } from "zod";

export const CronModelSchema = z.enum(["haiku", "sonnet", "opus"]);
export type CronModel = z.infer<typeof CronModelSchema>;

export const CronDeliverySchema = z.enum(["telegram", "gmail", "silent"]);
export type CronDelivery = z.infer<typeof CronDeliverySchema>;

// Frontmatter schema — what users write in the YAML block at the top of
// personal/cron/*.md files. All snake_case (matches the config convention).
export const CronFrontmatterSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "id must be kebab- or snake-case (lowercase)"),
  name: z.string().min(1),
  schedule: z.string().min(1, "schedule must be a 5-field cron expression"),
  timezone: z.string().optional(),
  model: CronModelSchema.default("sonnet"),
  timeout_ms: z
    .number()
    .int()
    .min(30_000, "timeout_ms minimum is 30s")
    .max(3_600_000, "timeout_ms maximum is 60min")
    .default(600_000),
  delivery: CronDeliverySchema.default("silent"),
  persistent_session: z.boolean().default(false),
  tools: z.array(z.string()).default(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]),
  enabled: z.boolean().default(true),
  catchup_window_minutes: z.number().int().positive().optional(),
  /**
   * For delivery=gmail jobs: the literal Subject: header the job sends.
   * Used by the catch-up gmail-check (§17.3 #9 (c)) — if a message with this
   * subject was sent in the last 24h, the job counts as completed even if
   * the journal says otherwise. Optional; omit for non-gmail jobs.
   */
  gmail_subject: z.string().optional(),
});

export type CronFrontmatter = z.infer<typeof CronFrontmatterSchema>;

export interface CronJob extends CronFrontmatter {
  /** Body of the markdown file after the frontmatter — the prompt itself. */
  instruction: string;
  /** Absolute path the job was loaded from. */
  source_path: string;
}
