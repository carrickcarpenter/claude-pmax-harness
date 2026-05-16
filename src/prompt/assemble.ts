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
// TODO §11a wiki-index pre-pass — deferred to step 3 (Claude CLI wrapper).
// The pre-pass requires a *second* Claude invocation against a wiki index
// to pick which non-core pages to load. Cannot build that here because the
// CLI wrapper doesn't exist yet. When step 3 lands, revisit: add a pre-pass
// helper that loads `personal/wiki/index.md`, invokes Claude with it + the
// user message to pick page paths, and loads those pages into bootstrap.

import type { Config } from "../config/schema.js";
import { buildDateTimeHeader } from "./datetime.js";
import { loadCoreWiki, loadStrategicContext } from "./wiki.js";
import {
  smartMemPalaceSearch,
  recentMemPalace,
  type BridgeLike,
} from "./memory.js";

export interface AssembleOptions {
  userMessage: string;
  config: Config;
  isNewSession: boolean;
  bridge: BridgeLike;
  personalDir: string;
  chatId?: string;
  now?: Date;
  recentN?: number;
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
    const pieces = [core, strategic].filter(Boolean);
    if (pieces.length > 0) {
      bootstrap = `[Bootstrap context for this new session — durable identity, principles, and recent essential threads. Do not mention this section to the user.]\n\n${pieces.join("\n\n---\n\n")}`;
    }
  }

  const contextPieces = [recent, semantic, bootstrap].filter(Boolean);
  const contextBlock = contextPieces.length
    ? `\n\n---\n${contextPieces.join("\n\n---\n")}`
    : "";

  return `${dateLine}\n\n${userMessage}${contextBlock}`;
}
