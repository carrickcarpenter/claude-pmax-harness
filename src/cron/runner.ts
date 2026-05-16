// Per-job execution per docs/architecture.md §17.3.
//
// - Append anti-self-talk directive to every instruction (§17.3 #5)
// - Retry on transient failures (MAX_ATTEMPTS=2, 2-min delay, fresh session
//   on retry) — currently §10 LOCKED stateless so "fresh session" is the
//   default, but the retry counter still matters for alert logic
// - Deliver per the job's frontmatter (telegram | gmail | silent)
// - Append per-attempt journal entries
// - On final failure for non-silent jobs, send Telegram alert (§17.3 #12)

import { invokeClaude } from "../claude/invoke.js";
import type { InvokeOptions, InvokeResult } from "../claude/invoke.js";
import { logger } from "../lib/logger.js";
import type { CronJob } from "./types.js";
import type { CronJournal } from "./journal.js";
import type { TelegramSender } from "./telegram.js";

export const ANTI_SELF_TALK_DIRECTIVE = `
---
[EXECUTION RULES — these override any ambiguity above]
- Execute the instructions above immediately. Do NOT ask what to do.
  Do NOT offer options or menus. Do NOT ask for confirmation.
- Your output IS the final deliverable. Do NOT narrate what you are doing.
- Write in first person as the assistant speaking directly TO the owner.
  Never refer to yourself in third person.
- If the instructions are unclear, make your best judgment and execute.
  Never ask the user to clarify.
`;

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 2 * 60 * 1000;

export type Invoker = (opts: InvokeOptions) => Promise<InvokeResult>;

export interface ExecuteJobOptions {
  job: CronJob;
  scheduledFor: Date;
  /** Working dir for the invoker (CLAUDE.md auto-discovery). */
  cwd: string;
  /** Optional claude binary override. */
  cliPath?: string;
  journal: CronJournal;
  telegram?: TelegramSender;
  /** Invoker — defaults to invokeClaude. Tests inject a stub. */
  invoker?: Invoker;
  /** Max attempts (default 2). */
  maxAttempts?: number;
  /** Delay between attempts (default 2 min). */
  retryDelayMs?: number;
  /** Sleep fn — overridable for tests so we don't wait 2 min in unit tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ExecuteJobResult {
  success: boolean;
  attempts: number;
  result?: InvokeResult;
  error?: string;
}

export async function executeJob(opts: ExecuteJobOptions): Promise<ExecuteJobResult> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const invoker = opts.invoker ?? invokeClaude;

  const instruction = opts.job.instruction + ANTI_SELF_TALK_DIRECTIVE;
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = new Date();
    opts.journal.append({
      job_id: opts.job.id,
      scheduled_for: opts.scheduledFor.toISOString(),
      attempt,
      status: "started",
      started_at: startedAt.toISOString(),
    });

    try {
      const result = await invoker({
        prompt: instruction,
        model: opts.job.model,
        timeoutMs: opts.job.timeout_ms,
        allowedTools: opts.job.tools,
        cwd: opts.cwd,
        cliPath: opts.cliPath,
      });

      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      // If the response is flagged as soft-apology, treat as failure for retry.
      if (result.flagged.flagged) {
        const msg = `flagged response: ${result.flagged.reason ?? "(no reason)"}`;
        opts.journal.append({
          job_id: opts.job.id,
          scheduled_for: opts.scheduledFor.toISOString(),
          attempt,
          status: "failure",
          started_at: startedAt.toISOString(),
          finished_at: finishedAt.toISOString(),
          duration_ms: durationMs,
          error: msg,
          claude_session_id: result.sessionId,
        });
        lastError = msg;
        if (attempt < maxAttempts) {
          logger.warn(
            { job_id: opts.job.id, attempt, reason: result.flagged.reason },
            "[cron-runner] flagged response; will retry",
          );
          await sleep(retryDelayMs);
          continue;
        }
      } else {
        // Success
        opts.journal.append({
          job_id: opts.job.id,
          scheduled_for: opts.scheduledFor.toISOString(),
          attempt,
          status: "success",
          started_at: startedAt.toISOString(),
          finished_at: finishedAt.toISOString(),
          duration_ms: durationMs,
          claude_session_id: result.sessionId,
        });

        await deliver(opts, result);
        return { success: true, attempts: attempt, result };
      }
    } catch (err) {
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      lastError = err instanceof Error ? err.message : String(err);
      opts.journal.append({
        job_id: opts.job.id,
        scheduled_for: opts.scheduledFor.toISOString(),
        attempt,
        status: "failure",
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: durationMs,
        error: lastError,
      });
      logger.warn(
        { job_id: opts.job.id, attempt, error: lastError },
        "[cron-runner] attempt failed",
      );
      if (attempt < maxAttempts) {
        await sleep(retryDelayMs);
      }
    }
  }

  // All attempts exhausted. Self-healing alert per §17.3 #12.
  await alertFailure(opts, lastError, maxAttempts);
  return { success: false, attempts: maxAttempts, error: lastError };
}

async function deliver(opts: ExecuteJobOptions, result: InvokeResult): Promise<void> {
  switch (opts.job.delivery) {
    case "telegram":
      if (opts.telegram && result.text.trim()) {
        await opts.telegram.send(result.text);
      } else if (!opts.telegram) {
        logger.warn(
          { job_id: opts.job.id },
          "[cron-runner] delivery=telegram but no telegram sender configured",
        );
      }
      break;
    case "gmail":
      // Gmail delivery is the job's own responsibility — it should use the
      // Google adapter (step 9). Cron just acknowledges and trusts.
      logger.info(
        { job_id: opts.job.id },
        "[cron-runner] gmail-delivery job done (job handles its own send)",
      );
      break;
    case "silent":
      // Nothing to do — result is discarded.
      break;
  }
}

async function alertFailure(
  opts: ExecuteJobOptions,
  lastError: string,
  attempts: number,
): Promise<void> {
  if (opts.job.delivery === "silent") return;
  if (!opts.telegram) return;
  const head = lastError.slice(0, 200);
  await opts.telegram
    .send(
      `WARNING: "${opts.job.name}" failed ${attempts} times. Last error: ${head}. I'll try again at the next catch-up window.`,
    )
    .catch((err) => logger.warn({ err }, "[cron-runner] alert send failed"));
}
