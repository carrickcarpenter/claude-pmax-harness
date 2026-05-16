// Readline-based prompt helpers for the setup wizard. Kept testable by
// taking a `Prompter` function instead of reading stdin directly — tests
// inject a stub that returns canned answers.

import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";

export type Prompter = (question: string) => Promise<string>;

/** Default stdin/stdout prompter. */
export function makeStdinPrompter(): Prompter {
  let rl: ReadlineInterface | null = null;
  return async (question) => {
    rl = rl ?? createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<string>((res) => {
      rl!.question(question, (answer) => res(answer));
    });
  };
}

export interface AskOptions {
  /** Default value to suggest in the prompt + return on empty input. */
  default?: string;
  /** Reject input until validate returns null (= ok). String = error message shown to user. */
  validate?: (input: string) => string | null;
  /** Bypass to a fixed value (used for --non-interactive). */
  preset?: string;
}

/**
 * Ask a free-form text question. If `preset` is provided, returns it without
 * prompting (after validation). If `default` is provided, hitting enter
 * returns the default.
 */
export async function ask(
  prompter: Prompter,
  question: string,
  opts: AskOptions = {},
): Promise<string> {
  if (opts.preset !== undefined) {
    const err = opts.validate?.(opts.preset);
    if (err) {
      throw new Error(`preset value for "${question.trim()}": ${err}`);
    }
    return opts.preset;
  }
  const suffix = opts.default !== undefined ? ` [${opts.default}]` : "";
  while (true) {
    const raw = await prompter(`${question}${suffix} `);
    const value = raw.trim() === "" && opts.default !== undefined ? opts.default : raw.trim();
    if (!value && !opts.default) {
      // empty and no default — re-prompt
      continue;
    }
    const err = opts.validate?.(value);
    if (err) {
      console.log(`  ! ${err}`);
      continue;
    }
    return value;
  }
}

/** Yes/no question. `default` is one of true/false. */
export async function askYesNo(
  prompter: Prompter,
  question: string,
  opts: { default?: boolean; preset?: boolean } = {},
): Promise<boolean> {
  if (opts.preset !== undefined) return opts.preset;
  const def = opts.default;
  const suffix = def === true ? " [Y/n]" : def === false ? " [y/N]" : " [y/n]";
  while (true) {
    const raw = (await prompter(`${question}${suffix} `)).trim().toLowerCase();
    if (!raw && def !== undefined) return def;
    if (["y", "yes"].includes(raw)) return true;
    if (["n", "no"].includes(raw)) return false;
    console.log("  ! please answer y or n");
  }
}

// ── validators ────────────────────────────────────────────────────────────

export function validateNonEmpty(field: string): (s: string) => string | null {
  return (s) => (s.trim().length === 0 ? `${field} cannot be empty` : null);
}

export function validateTimezone(): (s: string) => string | null {
  return (s) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: s });
      return null;
    } catch {
      return `not a valid IANA timezone (e.g. America/New_York, Europe/London)`;
    }
  };
}

export function validateTelegramToken(): (s: string) => string | null {
  // Telegram bot tokens look like NNNNNNNNN:AA...AAAAA — at least one digit
  // group, a colon, and a long alphanumeric tail.
  return (s) =>
    /^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(s.trim())
      ? null
      : "expected a Telegram bot token in the form `123456789:AA...AAAAA`";
}

export function validateChatId(): (s: string) => string | null {
  return (s) =>
    /^-?\d+$/.test(s.trim())
      ? null
      : "chat_id must be a number (negative for channels/groups)";
}
