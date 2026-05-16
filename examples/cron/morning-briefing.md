---
id: morning-briefing
name: Morning Briefing
schedule: "30 7 * * *"
model: sonnet
timeout_ms: 600000
delivery: telegram
persistent_session: false
tools: [Read, Glob, Grep, WebSearch]
enabled: true
---

It's the start of {{owner.first_name}}'s day. Write a tight morning briefing
covering exactly:

1. **Top of mind** — one sentence on what to focus on today. Use
   `personal/wiki/follow-ups.md` and `personal/wiki/open-questions.md` if they
   exist; otherwise infer from recent conversation history.
2. **One thing to do first** — the smallest action that unblocks progress.
3. **Weather + day** — a single line: weekday, calendar date, weather if you
   can fetch it via WebSearch (low-confidence is fine; don't fabricate).

Keep the whole briefing under 12 lines. No greetings, no closings — go
straight into the content. Use plain Markdown formatting.

If `personal/wiki/follow-ups.md` and `personal/wiki/open-questions.md` are
both empty or missing, emit one line that simply says today's date and
"Wiki is empty — nothing queued."
