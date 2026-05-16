import { z } from "zod";

// Mirrors docs/architecture.md §4 runtime config schema.
// Includes additions from §17 (Alice audit) for bot watchdog, cron tick intervals,
// MemPalace smart-search thresholds, and Claude token compaction.
// All fields have defaults so personal/config.yaml stays sparse — wizard only
// writes what it collected from the user.
//
// CONVENTION: snake_case for all user-facing yaml keys (idiomatic for config
// files; also TypeScript users access via `config.cron.tick_interval_ms` etc.).

const TimezoneSchema = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: "must be a valid IANA timezone (e.g. America/New_York)" },
);

const TimeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM in 24-hour format");

export const OwnerSchema = z.object({
  name: z.string().min(1),
  timezone: TimezoneSchema,
});

export const AssistantSchema = z
  .object({
    name: z.string().min(1).default("Assistant"),
    heartbeat: z
      .object({
        enabled: z.boolean().default(true),
        every_hours: z.number().int().min(1).max(24).default(4),
        quiet_hours: z
          .object({
            start: TimeOfDaySchema,
            end: TimeOfDaySchema,
          })
          .default({ start: "22:00", end: "07:00" }),
      })
      .default({}),
  })
  .default({});

export const ToolsSchema = z
  .object({
    allow_dangerous: z.boolean().default(true),
    allow_self_healing: z.boolean().default(false),
  })
  .default({});

export const ClaudeSchema = z
  .object({
    binary: z.string().default("claude"),
    token_compaction_percent: z.number().int().min(10).max(95).default(60),
  })
  .default({});

export const BotSchema = z
  .object({
    watchdog: z
      .object({
        interval_ms: z
          .number()
          .int()
          .positive()
          .default(5 * 60 * 1000),
        max_failures: z.number().int().positive().default(3),
      })
      .default({}),
  })
  .default({});

export const CronSchema = z
  .object({
    tick_interval_ms: z.number().int().positive().default(30_000),
    tick_stall_ms: z
      .number()
      .int()
      .positive()
      .default(5 * 60 * 1000),
    catchup_window_minutes: z.number().int().positive().default(30),
    retry: z
      .object({
        max_attempts: z.number().int().min(1).max(10).default(2),
        backoff_seconds: z.number().int().positive().default(60),
      })
      .default({}),
  })
  .default({});

export const MemPalaceSchema = z
  .object({
    write_mode: z.enum(["sync", "async"]).default("sync"),
    smart_search: z
      .object({
        similarity_threshold: z.number().min(0).max(1).default(0.3),
        timeout_ms: z.number().int().positive().default(3000),
      })
      .default({}),
  })
  .default({});

export const WikiSchema = z
  .object({
    selection: z
      .enum(["always-all", "claude-index-prepass"])
      .default("claude-index-prepass"),
    synthesis: z
      .object({
        mode: z
          .enum(["cron", "on-demand", "post-turn"])
          .default("cron"),
        schedule: z.string().default("0 4 * * *"),
      })
      .default({}),
  })
  .default({});

export const MemorySchema = z
  .object({
    mempalace: MemPalaceSchema,
    wiki: WikiSchema,
  })
  .default({});

export const GoogleSchema = z
  .object({
    enabled: z.boolean().default(false),
    scopes: z.array(z.string()).default([]),
  })
  .default({});

export const PiiSchema = z
  .object({
    precommit_hook: z.boolean().default(false),
    pii_check_categories: z
      .array(z.enum(["email", "phone", "address", "calendar_id", "financial"]))
      .default(["email", "phone", "address", "calendar_id", "financial"]),
  })
  .default({});

export const ConfigSchema = z.object({
  owner: OwnerSchema,
  assistant: AssistantSchema,
  tools: ToolsSchema,
  claude: ClaudeSchema,
  bot: BotSchema,
  cron: CronSchema,
  memory: MemorySchema,
  google: GoogleSchema,
  pii: PiiSchema,
});

export type Config = z.infer<typeof ConfigSchema>;

// Env vars are secrets only — see .env.example
export const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "required — get from @BotFather"),
  TELEGRAM_OWNER_CHAT_ID: z.string().min(1, "required — your Telegram chat ID"),
  HARNESS_DATA_DIR: z.string().optional(),
  HARNESS_LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).optional(),
  CLAUDE_CLI: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;
