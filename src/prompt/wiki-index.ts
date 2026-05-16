// Wiki-index pre-pass for §11a LOCKED prompt selection.
//
// On a new session, before assembling the main prompt, run a short Claude
// invocation that's given the wiki INDEX (page titles + summaries) plus
// the incoming user message, and asks "which pages are relevant?"
// Then load the picked pages into the bootstrap context.
//
// This is the §11a recommendation: use Claude's own judgment for wiki
// selection without paying the cost of stuffing the entire wiki every turn.
// Trade-off: 2 invocations per turn instead of 1; mitigated by implicit
// prompt caching under Pro/Max (see project memory pmax-cli-fundamentals).
//
// The invoker is injected so tests can mock without spawning a real CLI.

import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../lib/logger.js";
import {
  invokeClaude,
  type InvokeOptions,
  type InvokeResult,
  type ClaudeModel,
} from "../claude/invoke.js";

export type Invoker = (opts: InvokeOptions) => Promise<InvokeResult>;

export interface SelectRelevantPagesOptions {
  personalDir: string;
  userMessage: string;
  /** Defaults to invokeClaude. Tests inject a stub. */
  invoker?: Invoker;
  /** Claude binary path passed through to the invoker. */
  cliPath?: string;
  /** Model tier — Haiku by default (cheap pre-pass). */
  model?: ClaudeModel;
  /** Hard ceiling per §17.2 #2. Default 30s. */
  timeoutMs?: number;
  /** Max pages to return (allow-listed against actual files). Default 5. */
  maxPages?: number;
}

/**
 * Returns a sorted, validated list of wiki page paths (relative to
 * personal/wiki/) selected as relevant by the pre-pass. Returns [] silently
 * when:
 * - personal/wiki/ does not exist
 * - index.md is absent
 * - no non-index pages exist
 * - the invoker errors / times out / returns a flagged response
 * - the model returns no recognizable paths
 *
 * Never throws.
 */
export async function selectRelevantWikiPages(
  opts: SelectRelevantPagesOptions,
): Promise<string[]> {
  const wikiDir = resolve(opts.personalDir, "wiki");
  if (!existsSync(wikiDir)) return [];

  const indexPath = resolve(wikiDir, "index.md");
  if (!existsSync(indexPath)) return [];

  const candidatePages = enumerateWikiPages(wikiDir);
  if (candidatePages.length === 0) return [];

  const indexContent = safeRead(indexPath);
  if (!indexContent) return [];

  const maxPages = opts.maxPages ?? 5;
  const prompt = buildPrePassPrompt({
    userMessage: opts.userMessage,
    candidates: candidatePages,
    indexContent,
    maxPages,
  });

  const invoker = opts.invoker ?? invokeClaude;
  let result: InvokeResult;
  try {
    result = await invoker({
      prompt,
      model: opts.model ?? "haiku",
      allowedTools: [],
      timeoutMs: opts.timeoutMs ?? 30_000,
      cliPath: opts.cliPath,
      cwd: opts.personalDir,
    });
  } catch (err) {
    logger.warn({ err }, "[wiki-index] pre-pass invoker failed; skipping");
    return [];
  }

  if (result.flagged.flagged) {
    logger.warn(
      { reason: result.flagged.reason },
      "[wiki-index] pre-pass returned flagged response; skipping",
    );
    return [];
  }

  const picks = parsePicks(result.text);
  const allowed = new Set(candidatePages);
  const valid = picks.filter((p) => allowed.has(p));
  return valid.slice(0, maxPages);
}

function enumerateWikiPages(wikiDir: string, prefix = ""): string[] {
  const out: string[] = [];
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(wikiDir, { withFileTypes: true }) as Dirent[];
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = resolve(wikiDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...enumerateWikiPages(abs, rel));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".md") &&
      // Exclude the always-loaded core pages and meta files.
      entry.name !== "index.md" &&
      entry.name !== "identity.md" &&
      entry.name !== "principles.md" &&
      entry.name !== "WIKI.md" &&
      entry.name !== "follow-ups.md" &&
      entry.name !== "open-questions.md"
    ) {
      out.push(rel);
    }
  }
  return out;
}

interface BuildPromptOptions {
  userMessage: string;
  candidates: string[];
  indexContent: string;
  maxPages: number;
}

function buildPrePassPrompt(opts: BuildPromptOptions): string {
  return [
    "You are selecting which wiki pages are most relevant to the user's current message.",
    "",
    "## Available wiki pages (allowlist — only return paths from this exact list)",
    "```",
    opts.candidates.join("\n"),
    "```",
    "",
    "## Wiki index (page titles and summaries)",
    "```markdown",
    opts.indexContent,
    "```",
    "",
    "## User's message",
    "```",
    opts.userMessage,
    "```",
    "",
    "## Task",
    `Pick up to ${opts.maxPages} wiki pages from the allowlist above whose content is most likely relevant to contextualizing or answering the user's message. Return ONLY a newline-separated list of paths exactly as they appear in the allowlist (e.g. \`projects/auth.md\`). No commentary, no markdown, no quoting. If no pages are relevant, return nothing.`,
  ].join("\n");
}

function parsePicks(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^[-*]\s*/, "")) // strip list bullets
    .map((line) => line.replace(/^[`'"]+|[`'"]+$/g, "")) // strip quoting
    .filter(Boolean)
    .filter((line) => !line.startsWith("#")) // skip prose
    .filter((line) => /^[a-zA-Z0-9_./-]+\.md$/.test(line));
}

function safeRead(path: string): string | null {
  if (!statSync(path).isFile()) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

export const _internal = { enumerateWikiPages, parsePicks, buildPrePassPrompt };
