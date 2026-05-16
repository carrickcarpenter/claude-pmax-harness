// Prompt assembly per docs/architecture.md §11 + §17.1 #1 + §17.6.
//
// Layout (in order):
//   1. Date/time line (§17.1 #1) — authoritative; goes BEFORE user message
//      AND BEFORE any memory context so the model never picks up stale dates
//      from memory.
//   2. User message
//   3. (NEW SESSION ONLY) Bootstrap context: wiki core pages + strategic context
//   4. Recent-N MemPalace entries (§17.6 #3, §11b hybrid floor)
//   5. Smart-search semantic results (§17.6 #6 / §11b hybrid supplement) with
//      anti-echo directive (§17.6 #7).
//
// Output: a single string ready to pass to `claude -p`.
//
// §11a wiki-index pre-pass — implemented in step 3 (now). Caller opts in by
// passing `wikiIndexPrePass: { invoker | cliPath, ... }`. See src/prompt/
// wiki-index.ts for the picker; this assembler reads selected page contents
// into the bootstrap section. Graceful: if pre-pass fails for any reason,
// the assembler still ships a complete prompt without extra wiki pages.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "../config/schema.js";
import { buildDateTimeHeader } from "./datetime.js";
import { loadCoreWiki, loadStrategicContext } from "./wiki.js";
import {
  smartMemPalaceSearch,
  recentMemPalace,
  type BridgeLike,
} from "./memory.js";
import {
  selectRelevantWikiPages,
  type Invoker,
} from "./wiki-index.js";
import { logger } from "../lib/logger.js";

export interface AssembleOptions {
  userMessage: string;
  config: Config;
  isNewSession: boolean;
  bridge: BridgeLike;
  personalDir: string;
  chatId?: string;
  now?: Date;
  recentN?: number;
  /**
   * Pre-formatted conversation buffer (per §17.6 #3 — the bot's disk-
   * persisted recent-exchanges store). Under §10 stateless LOCKED, this is
   * the primary thread-continuity mechanism. Pass "" or omit on the very
   * first turn or after /clear.
   */
  conversationBuffer?: string;
  /**
   * If provided, runs the §11a wiki-index pre-pass on new sessions to pick
   * additional relevant non-core wiki pages. Pass `invoker` to inject a stub
   * in tests; pass `cliPath` for production use against the real claude CLI.
   * If omitted, no pre-pass runs (core pages still load).
   */
  wikiIndexPrePass?: {
    invoker?: Invoker;
    cliPath?: string;
    timeoutMs?: number;
    maxPages?: number;
  };
}

export async function assemblePrompt(opts: AssembleOptions): Promise<string> {
  const {
    userMessage,
    config,
    isNewSession,
    bridge,
    personalDir,
    chatId,
    recentN = 5,
  } = opts;
  const now = opts.now ?? new Date();

  const dateLine = buildDateTimeHeader(config.owner.timezone, now);

  const [recent, semantic] = await Promise.all([
    recentMemPalace(bridge, {
      n: recentN,
      timeoutMs: config.memory.mempalace.smart_search.timeout_ms,
      chatId,
    }),
    smartMemPalaceSearch(bridge, userMessage, {
      similarityThreshold: config.memory.mempalace.smart_search.similarity_threshold,
      timeoutMs: config.memory.mempalace.smart_search.timeout_ms,
    }),
  ]);

  let bootstrap = "";
  if (isNewSession) {
    const core = loadCoreWiki(personalDir);
    const strategic = loadStrategicContext(personalDir);

    // §11a wiki-index pre-pass — only when explicitly enabled and the caller
    // supplied a way to invoke Claude. Picks additional non-core wiki pages
    // that are likely relevant to the current message.
    const prePassPages: string[] = [];
    if (opts.wikiIndexPrePass) {
      try {
        const picks = await selectRelevantWikiPages({
          personalDir,
          userMessage,
          invoker: opts.wikiIndexPrePass.invoker,
          cliPath: opts.wikiIndexPrePass.cliPath,
          timeoutMs: opts.wikiIndexPrePass.timeoutMs,
          maxPages: opts.wikiIndexPrePass.maxPages,
        });
        for (const rel of picks) {
          const abs = resolve(personalDir, "wiki", rel);
          if (existsSync(abs)) {
            try {
              prePassPages.push(`## wiki/${rel}\n\n${readFileSync(abs, "utf-8")}`);
            } catch (err) {
              logger.warn({ err, page: rel }, "[assemble] failed to read pre-pass page");
            }
          }
        }
      } catch (err) {
        logger.warn({ err }, "[assemble] wiki-index pre-pass threw; continuing without it");
      }
    }
    const prePassBlock = prePassPages.length
      ? `# Additional wiki pages selected for this turn\n\n${prePassPages.join("\n\n")}`
      : "";

    const pieces = [core, prePassBlock, strategic].filter(Boolean);
    if (pieces.length > 0) {
      bootstrap = `[Bootstrap context for this new session — durable identity, principles, and recent essential threads. Do not mention this section to the user.]\n\n${pieces.join("\n\n---\n\n")}`;
    }
  }

  // Order matters: conversation buffer (continuity) > recent (MemPalace) >
  // semantic (relevance) > bootstrap (identity). Closer-to-user-message
  // = higher continuity influence.
  const contextPieces = [
    opts.conversationBuffer ?? "",
    recent,
    semantic,
    bootstrap,
  ].filter(Boolean);
  const contextBlock = contextPieces.length
    ? `\n\n---\n${contextPieces.join("\n\n---\n")}`
    : "";

  return `${dateLine}\n\n${userMessage}${contextBlock}`;
}
