// Wiki loader for prompt assembly per docs/architecture.md §17.6 #8.
//
// Loads only the "always-on" core pages (index.md, identity.md, principles.md)
// from personal/wiki/ into new chat sessions. Other pages are reachable on
// demand via the Read tool when the assistant needs them.
//
// 30s cache TTL — short enough that user/assistant edits show up almost
// immediately, long enough to absorb chat bursts without re-reading.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../lib/logger.js";

const CORE_PAGES = ["index.md", "identity.md", "principles.md"];
const CORE_TTL_MS = 30 * 1000;
const STRATEGIC_TTL_MS = 60 * 1000;
const STRATEGIC_MAX_CHARS = 8000;

interface CacheEntry {
  text: string;
  expiresAt: number;
}

let coreCache: { dir: string; entry: CacheEntry } | null = null;
let strategicCache: { dir: string; entry: CacheEntry } | null = null;

export function loadCoreWiki(personalDir: string, now: number = Date.now()): string {
  if (
    coreCache &&
    coreCache.dir === personalDir &&
    coreCache.entry.expiresAt > now
  ) {
    return coreCache.entry.text;
  }
  const wikiDir = resolve(personalDir, "wiki");
  if (!existsSync(wikiDir)) {
    coreCache = {
      dir: personalDir,
      entry: { text: "", expiresAt: now + CORE_TTL_MS },
    };
    return "";
  }
  const sections: string[] = [];
  for (const page of CORE_PAGES) {
    const path = resolve(wikiDir, page);
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, "utf-8");
      sections.push(`## wiki/${page}\n\n${content}`);
    } catch (err) {
      logger.warn({ err, page }, "[wiki] failed to read core page");
    }
  }
  if (sections.length === 0) {
    coreCache = {
      dir: personalDir,
      entry: { text: "", expiresAt: now + CORE_TTL_MS },
    };
    return "";
  }
  const text = [
    "# Wiki (durable, hand-curated context)",
    "",
    "The following are the always-loaded pages from `personal/wiki/`. This wiki is your durable, portable, git-versioned kernel of context — separate from MemPalace's verbatim recall. You own this wiki and are responsible for keeping it current. When you learn something new, update the relevant page or create a new one and add it to `index.md`. Pages not loaded here are still reachable on demand via the Read tool (`personal/wiki/...`).",
    "",
    ...sections,
  ].join("\n");
  coreCache = {
    dir: personalDir,
    entry: { text, expiresAt: now + CORE_TTL_MS },
  };
  return text;
}

export function loadStrategicContext(
  personalDir: string,
  now: number = Date.now(),
): string {
  if (
    strategicCache &&
    strategicCache.dir === personalDir &&
    strategicCache.entry.expiresAt > now
  ) {
    return strategicCache.entry.text;
  }
  const wikiDir = resolve(personalDir, "wiki");
  if (!existsSync(wikiDir)) {
    strategicCache = {
      dir: personalDir,
      entry: { text: "", expiresAt: now + STRATEGIC_TTL_MS },
    };
    return "";
  }

  const sections: string[] = [];
  let totalChars = 0;

  // 1. Active follow-ups — top priority
  const followUps = resolve(wikiDir, "follow-ups.md");
  if (existsSync(followUps)) {
    try {
      const content = readFileSync(followUps, "utf-8");
      const active = content
        .split("\n")
        .filter((line) => /^- \[ \]/.test(line.trim()));
      if (active.length > 0) {
        const block = `## Active Follow-Ups\n${active.join("\n")}`;
        sections.push(block);
        totalChars += block.length;
      }
    } catch (err) {
      logger.warn({ err }, "[wiki] failed to read follow-ups");
    }
  }

  // 2. Open questions (active section only)
  const openQ = resolve(wikiDir, "open-questions.md");
  if (existsSync(openQ)) {
    try {
      const content = readFileSync(openQ, "utf-8");
      const resolvedIdx = content.search(/^## .*Resolved/m);
      const activeContent =
        resolvedIdx >= 0 ? content.slice(0, resolvedIdx).trim() : content.trim();
      if (activeContent.length > 20) {
        const remaining = STRATEGIC_MAX_CHARS - totalChars - 200;
        if (remaining > 100) {
          const block = `## Open Questions\n${activeContent.slice(0, remaining)}`;
          sections.push(block);
          totalChars += block.length;
        }
      }
    } catch (err) {
      logger.warn({ err }, "[wiki] failed to read open-questions");
    }
  }

  // 3. Recent decisions (7-day window, by mtime)
  const decisionsDir = resolve(wikiDir, "decisions");
  if (existsSync(decisionsDir)) {
    try {
      const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
      const recent: string[] = [];
      for (const file of readdirSync(decisionsDir)) {
        if (!file.endsWith(".md")) continue;
        const filePath = resolve(decisionsDir, file);
        const stat = statSync(filePath);
        if (stat.mtimeMs >= sevenDaysAgo) {
          const content = readFileSync(filePath, "utf-8");
          const titleMatch = content.match(/^#\s+(.+)/m);
          const title = titleMatch
            ? titleMatch[1]
            : file.replace(/\.md$/, "");
          recent.push(`- ${file}: ${title}`);
        }
      }
      if (recent.length > 0) {
        const remaining = STRATEGIC_MAX_CHARS - totalChars - 100;
        if (remaining > 100) {
          sections.push(
            `## Recent Decisions (last 7 days)\n${recent.join("\n").slice(0, remaining)}`,
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, "[wiki] failed to read decisions dir");
    }
  }

  if (sections.length === 0) {
    strategicCache = {
      dir: personalDir,
      entry: { text: "", expiresAt: now + STRATEGIC_TTL_MS },
    };
    return "";
  }
  const text = `# Strategic Context (active commitments & open threads)\n\n${sections.join("\n\n")}`;
  strategicCache = {
    dir: personalDir,
    entry: { text, expiresAt: now + STRATEGIC_TTL_MS },
  };
  return text;
}

export function invalidateWikiCaches(): void {
  coreCache = null;
  strategicCache = null;
}
