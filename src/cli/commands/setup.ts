// `harness setup` CLI command — first-run wizard per docs/architecture.md §7.

import { EXIT_CODES } from "../../lib/errors.js";
import { runWizard } from "../../setup/wizard.js";
import { makeStdinPrompter } from "../../setup/prompts.js";

export interface SetupCommandOptions {
  projectRoot: string;
  nonInteractive?: boolean;
  force?: boolean;
  /** Telegram chat_id escape hatch (for "I'm not on Telegram during setup"). */
  chatId?: string;
  /** --non-interactive presets — forward to runWizard.preset. */
  ownerName?: string;
  timezone?: string;
  assistantName?: string;
  telegramToken?: string;
  googleEnabled?: boolean;
  precommitHook?: boolean;
  allowDangerous?: boolean;
}

export async function runSetup(opts: SetupCommandOptions): Promise<number> {
  const result = await runWizard({
    projectRoot: opts.projectRoot,
    prompter: makeStdinPrompter(),
    nonInteractive: opts.nonInteractive,
    force: opts.force,
    preset: {
      owner_name: opts.ownerName,
      timezone: opts.timezone,
      assistant_name: opts.assistantName,
      telegram_token: opts.telegramToken,
      telegram_chat_id: opts.chatId,
      google_enabled: opts.googleEnabled,
      precommit_hook: opts.precommitHook,
      allow_dangerous: opts.allowDangerous,
    },
  });
  // If doctor returned non-zero, surface but don't override — the user has a
  // valid setup state; doctor's failures are remediable.
  if (result.doctor_exit !== undefined && result.doctor_exit !== 0) {
    return result.doctor_exit;
  }
  return EXIT_CODES.SUCCESS;
}
