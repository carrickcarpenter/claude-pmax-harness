import { describe, test, expect, beforeAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import {
  classifyResponse,
  ERROR_RESPONSE_PATTERNS,
  API_ERROR_PATTERNS,
} from "../src/claude/error-shapes.js";
import { invokeClaude } from "../src/claude/invoke.js";
import { ExternalError } from "../src/lib/errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUB_PATH = resolve(__dirname, "stub-claude.py");

function runWithMode(mode: string, extraEnv: Record<string, string> = {}) {
  return invokeClaude({
    prompt: "hello stub",
    cliPath: STUB_PATH,
    timeoutMs: 5000,
    allowedTools: [],
    cwd: __dirname,
    onText: extraEnv.__onText
      ? (extraEnv.__onText as unknown as (s: string) => void)
      : undefined,
    onToolUse: extraEnv.__onToolUse
      ? (extraEnv.__onToolUse as unknown as (s: string) => void)
      : undefined,
  });
}

// We control the stub via env vars. Pass via process.env mutation per test —
// the stub reads them on spawn.
function withStubEnv(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const original: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    original[k] = process.env[k];
    process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });
}

beforeAll(() => {
  // Sanity-check that the stub is executable and python3 is on PATH.
  execSync(`python3 ${STUB_PATH} -p ping`, { timeout: 3000 });
});

// ── error-shapes ────────────────────────────────────────────────────────

describe("classifyResponse", () => {
  test("returns not-flagged on normal text", () => {
    const out = classifyResponse("Here is a normal helpful response.");
    expect(out.flagged).toBe(false);
  });

  test.each(ERROR_RESPONSE_PATTERNS)(
    "flags apology shapes matching %s",
    (pattern) => {
      const samples: Record<string, string> = {
        [/sorry.*hit an error/i.source]: "Sorry, I hit an error processing that.",
        [/i['']ll be back shortly/i.source]: "I'll be back shortly!",
        [/something went wrong/i.source]: "Something went wrong, please try again.",
        [/i encountered an? (?:error|issue|problem)/i.source]:
          "I encountered an error during the request.",
        [/i['']m having (?:trouble|difficulty|issues)/i.source]:
          "I'm having trouble reaching the service.",
        [/unable to (?:process|complete|respond)/i.source]:
          "Unable to complete the request.",
      };
      const sample = samples[pattern.source];
      if (!sample) throw new Error(`no sample for pattern ${pattern.source}`);
      const out = classifyResponse(sample);
      expect(out.flagged).toBe(true);
      expect(out.category).toBe("soft-apology");
    },
  );

  test("flags API-error shapes with category api-error", () => {
    const out = classifyResponse(
      'API Error: {"type":"error","error":{"type":"overloaded_error","message":"x"}}',
    );
    expect(out.flagged).toBe(true);
    expect(out.category).toBe("api-error");
  });

  test("does NOT flag prose that merely mentions error-type names", () => {
    // Discussion of error handling in docs/replies shouldn't flag — the regex
    // requires the `"type":"error"` JSON shape to be present.
    const out = classifyResponse(
      "In our docs we discuss overloaded_error and rate_limit_error scenarios.",
    );
    expect(out.flagged).toBe(false);
  });

  test("API_ERROR_PATTERNS includes the four documented error types", () => {
    const src = API_ERROR_PATTERNS.map((p) => p.source).join("|");
    expect(src).toContain("overloaded_error");
    expect(src).toContain("rate_limit_error");
    expect(src).toContain("api_error");
    expect(src).toContain("invalid_request_error");
  });
});

// ── invokeClaude (against stub) ─────────────────────────────────────────

describe("invokeClaude (stub binary)", () => {
  test("normal mode returns expected echo text + session id", async () => {
    await withStubEnv({ STUB_MODE: "normal" }, async () => {
      const result = await runWithMode("normal");
      expect(result.text).toMatch(/^You said: hello stub/);
      expect(result.sessionId).toBe("stub-session-1");
      expect(result.flagged.flagged).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  test("multiline mode invokes onText for each delta + returns final result", async () => {
    await withStubEnv({ STUB_MODE: "multiline" }, async () => {
      const deltas: string[] = [];
      const result = await invokeClaude({
        prompt: "p",
        cliPath: STUB_PATH,
        timeoutMs: 5000,
        allowedTools: [],
        onText: (d) => deltas.push(d),
      });
      expect(deltas.length).toBeGreaterThan(1);
      expect(result.text).toBe("Hello world from the stub.");
    });
  });

  test("tool mode invokes onToolUse callback", async () => {
    await withStubEnv({ STUB_MODE: "tool" }, async () => {
      const tools: string[] = [];
      const result = await invokeClaude({
        prompt: "p",
        cliPath: STUB_PATH,
        timeoutMs: 5000,
        allowedTools: [],
        onToolUse: (t) => tools.push(t),
      });
      expect(tools).toContain("Read");
      expect(result.text).toBe("I read a file. Done.");
    });
  });

  test("apology mode returns text but flags it as soft-apology", async () => {
    await withStubEnv({ STUB_MODE: "apology" }, async () => {
      const result = await runWithMode("apology");
      expect(result.text).toMatch(/Sorry/);
      expect(result.flagged.flagged).toBe(true);
      expect(result.flagged.category).toBe("soft-apology");
    });
  });

  test("apierror mode REJECTS (API error in result)", async () => {
    await withStubEnv({ STUB_MODE: "apierror" }, async () => {
      await expect(runWithMode("apierror")).rejects.toBeInstanceOf(ExternalError);
    });
  });

  test("noresult mode REJECTS (exit 0 but no result event)", async () => {
    await withStubEnv({ STUB_MODE: "noresult" }, async () => {
      await expect(runWithMode("noresult")).rejects.toThrow(/no result/);
    });
  });

  test("hang mode hits hard ceiling and REJECTS", async () => {
    await withStubEnv({ STUB_MODE: "hang" }, async () => {
      await expect(
        invokeClaude({
          prompt: "p",
          cliPath: STUB_PATH,
          timeoutMs: 500,
          allowedTools: [],
        }),
      ).rejects.toThrow(/hard ceiling/);
    });
  });

  test("does not pass --system-prompt as a CLI arg (§17.2 #5)", async () => {
    // Source-level guard: the args array never contains the string literal.
    // Comments mentioning the rule (e.g. "NEVER pass --system-prompt") don't
    // match because they aren't quoted.
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      resolve(__dirname, "..", "src", "claude", "invoke.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/['"]--system-prompt['"]/);
  });
});
