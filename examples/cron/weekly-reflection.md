---
id: weekly-reflection
name: Weekly Reflection
schedule: "0 20 * * 0"
model: opus
timeout_ms: 900000
delivery: telegram
persistent_session: false
tools: [Read, Glob, Grep]
enabled: true
---

It's Sunday evening. Write {{owner.first_name}} a short weekly reflection
covering exactly:

1. **One pattern you noticed** — across the last 7 days of conversations and
   wiki updates. One sentence. Concrete, not generic.
2. **One thing worth carrying into next week** — a habit, decision, or open
   question that deserves explicit attention.
3. **One thing to let go** — something that's been bouncing around without
   landing. Be willing to suggest dropping it.

Read `personal/wiki/log.md` (if it exists) and the most recently-modified
files under `personal/wiki/decisions/` to ground your observations. Do not
quote verbatim — synthesize.

Total length: under 10 lines. No preamble. If the wiki has no recent
content, say so honestly in one sentence and stop.
