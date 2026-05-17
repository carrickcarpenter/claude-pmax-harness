# Cron recipes — daily routines for your bot

This is the friendly tour of how to make your bot do things on a
schedule. By the end you'll know how to author your own jobs from
scratch, and you'll have a gallery of 12 examples you can copy + adapt.

You don't need to be a developer. You just need to be willing to edit a
text file.

---

## What is a "cron job"?

A cron job is a prompt your bot runs on a schedule — like a tiny
recurring chore you've delegated to it. The bot wakes up at the time
you specified, runs the prompt, and delivers the result however you
asked (Telegram message, silent file write, etc.).

The harness ships with two example cron jobs in `personal/cron/` after
you run `harness setup`:

- `morning-briefing.md` — fires at 07:30, sends a short morning brief
- `weekly-reflection.md` — fires Sunday 20:00, sends a weekly nudge

Cron jobs live as **Markdown files** in `~/claude-pmax-harness/personal/cron/`.
The top of each file is a "frontmatter" block (the part between `---`
lines) that tells the harness when/how to run the job. The rest of the
file is the prompt the bot reads.

---

## The frontmatter, field by field

Every cron job has a frontmatter block. Here's the full set of fields:

```yaml
---
id: morning-briefing                # short, unique, lowercase kebab-case
name: Morning Briefing              # human-readable; used in alerts
schedule: "30 7 * * *"              # 5-field cron expression (see below)
timezone: "America/New_York"        # optional; defaults to your config timezone
model: sonnet                       # haiku | sonnet | opus
timeout_ms: 600000                  # max wall-clock time (ms); default 600000 (10 min)
delivery: telegram                  # telegram | gmail | silent
persistent_session: false           # almost always false (see warning)
tools: [Read, Glob, Grep, WebSearch]  # which tools Claude can use
enabled: true                       # set false to skip without deleting
gmail_subject: "Morning Briefing"   # optional; only for delivery: gmail (see below)
---

(your prompt goes here, after the closing ---)
```

What each one means:

- **`id`** — internal name. Used in logs, in `harness cron run <id>`, and
  in catch-up tracking. Don't change it after the job has run; the
  catch-up system uses it to dedup.
- **`name`** — what shows in failure alerts ("⚠️ 'Morning Briefing' failed").
- **`schedule`** — a 5-field cron expression. The next section is a cheat
  sheet for these.
- **`timezone`** — leave blank to use your config's owner timezone (the
  common case). Only override if a job needs to fire on a different
  city's clock.
- **`model`** — pick the cheapest model that does the job:
  - `haiku` — fastest, cheapest, fine for "summarize this short thing"
    or "format this list"
  - `sonnet` — middle tier, fine for most jobs
  - `opus` — slowest, smartest, use for deep synthesis (weekly
    reflections, monthly reviews)
- **`timeout_ms`** — kill the job after this many milliseconds if it
  hasn't returned. 5 min = `300000`, 10 min = `600000`, 30 min = `1800000`,
  60 min = `3600000`. Default is 10 min.
- **`delivery`** — where the result goes:
  - `telegram` — sent to you via the bot
  - `gmail` — the job itself sends the email using the Gmail adapter
    (so the prompt has to include "use the Gmail adapter to send to
    me@example.com")
  - `silent` — the result is discarded (useful for "do a thing, no
    output needed" jobs like file maintenance)
- **`persistent_session`** — almost always leave `false`. Setting it
  `true` makes the job remember its previous run, which can be useful
  for trend-tracking but also causes "context bleed" (the bot
  accidentally references stale data). Only flip if you really need it.
- **`tools`** — which Claude tools the job can use:
  - `Read` — read files (essential for most jobs)
  - `Glob` — find files by pattern
  - `Grep` — search file contents
  - `WebSearch` — web search via Anthropic
  - `WebFetch` — fetch a specific URL
  - `Bash` — run shell commands (powerful; only include if you really need it)
  - `Write`, `Edit` — modify files (powerful; only include if needed)
- **`enabled`** — `false` to skip the job without deleting the file.
  Useful for muting a job temporarily.
- **`gmail_subject`** — only matters when `delivery: gmail`. It's the
  literal `Subject:` header the job will send. The cron catch-up check
  uses it to verify the email actually got sent (so if a job thinks it
  succeeded but the email never arrived, catch-up re-fires it).

---

## Cron expression cheat sheet

The `schedule` field is a 5-field expression:

```
* * * * *
│ │ │ │ │
│ │ │ │ └── day of week (0–6, 0 = Sunday)
│ │ │ └──── month (1–12)
│ │ └────── day of month (1–31)
│ └──────── hour (0–23)
└────────── minute (0–59)
```

Common patterns:

| Cron expression | When it fires |
|---|---|
| `30 7 * * *` | every day at 7:30 AM |
| `0 9 * * *` | every day at 9:00 AM |
| `0 8 * * 1-5` | weekdays at 8:00 AM (Mon-Fri) |
| `0 18 * * 0` | every Sunday at 6:00 PM |
| `0 9 * * 6` | every Saturday at 9:00 AM |
| `*/15 * * * *` | every 15 minutes (use sparingly) |
| `0 * * * *` | top of every hour |
| `0 0 * * *` | midnight every day |
| `0 9 1 * *` | the 1st of every month at 9:00 AM |
| `0 12 * * 1,3,5` | Mon/Wed/Fri at noon |
| `0 7 1-7 * 1` | the first Monday of each month at 7:00 AM (1st-7th + Mon) |

Times are in **your config's timezone** unless you override per-job with
the `timezone` field.

Tip: if you want to know exactly when your job will next fire, run:

```bash
npm run -s harness -- cron next
```

That prints the next 10 fires across all your jobs in chronological
order.

---

## Tutorial — write your first cron job from scratch

Let's make a job that sends a wisdom quote every weekday morning.

### Step 1: create the file

```bash
cd ~/claude-pmax-harness
nano personal/cron/daily-quote.md
```

### Step 2: paste this in

```yaml
---
id: daily-quote
name: Daily Wisdom Quote
schedule: "0 7 * * 1-5"
model: haiku
timeout_ms: 300000
delivery: telegram
persistent_session: false
tools: []
enabled: true
---

Pick one short, original quote about thinking clearly,
making decisions, or staying focused. Don't quote anyone
famous — make it up. Don't say "Here's a quote" or any
preamble. Just emit the quote.

Keep it under 25 words.
```

Save and close (in nano: Ctrl-O, Enter, Ctrl-X).

### Step 3: verify the harness sees it

```bash
npm run -s harness -- cron list
```

You should see `daily-quote` in the list with `schedule="0 7 * * 1-5"`.

### Step 4: test it without waiting until tomorrow

```bash
npm run -s harness -- cron run daily-quote
```

This fires the job right now, ignoring its schedule. You should see it
take a few seconds, then the quote arrives on Telegram. The bot also
appends a journal entry — view with:

```bash
npm run -s harness -- cron status
```

### Step 5: let the scheduler take over

If pm2 is running the harness (`pm2 status` shows `claude-pmax-harness
online`), the scheduler is already loaded. But it loads jobs at start —
so to pick up your new job, restart:

```bash
pm2 restart claude-pmax-harness
```

Done. Tomorrow at 7:00 AM (and every weekday after), you'll get the quote.

To disable it later, set `enabled: false` in the file and `pm2 restart
claude-pmax-harness`.

---

## Recipe gallery

Twelve example jobs across difficulty tiers. Copy any of these into
`personal/cron/<id>.md`, adjust the `id`/`name`/`schedule`, run
`pm2 restart claude-pmax-harness`, and you're live.

### Easy — no external integrations needed

#### 1. Today-in-history snippet

```yaml
---
id: today-in-history
name: Today in History
schedule: "0 8 * * *"
model: haiku
timeout_ms: 120000
delivery: telegram
persistent_session: false
tools: []
enabled: true
---

Pick ONE interesting historical event that happened on this
calendar date (any year). 1–3 sentences. Skip the date intro;
just open with the event. End with one sentence on why it
still matters today.

Keep total length under 100 words.
```

#### 2. Friday "plan your weekend" nudge

```yaml
---
id: friday-weekend-nudge
name: Weekend Planner
schedule: "0 16 * * 5"
model: sonnet
timeout_ms: 300000
delivery: telegram
persistent_session: false
tools: [Read, Glob, Grep]
enabled: true
---

It's Friday afternoon. Look at personal/wiki/follow-ups.md and
personal/wiki/open-questions.md if they exist. Suggest one
specific thing the user could do this weekend that would
genuinely move something forward — not a chore list. Be specific
("draft the email to Jane about X" not "respond to emails").

Format:
**One thing for this weekend:**
<the suggestion, 2-3 sentences>
**Why:** <one sentence>

If nothing in the wiki suggests something, say so honestly and
suggest "rest" as the answer.
```

#### 3. Monday morning intention

```yaml
---
id: monday-intention
name: Monday Intention
schedule: "30 7 * * 1"
model: sonnet
timeout_ms: 300000
delivery: telegram
persistent_session: false
tools: [Read]
enabled: true
---

It's Monday morning. Read personal/wiki/principles.md and
personal/wiki/identity.md. Compose ONE sentence to set the
intention for the week — drawing from those files, not generic
wisdom. The sentence should sound like the user wrote it for
themselves, not a fortune cookie. Then a second sentence with
the smallest concrete first action.

Format:
**This week:** <intention>
**Start with:** <first action>
```

### Medium — uses WebSearch / WebFetch (works out of the box)

#### 4. Hacker News top story summary

```yaml
---
id: hn-morning
name: HN Morning Brief
schedule: "0 7 * * *"
model: sonnet
timeout_ms: 600000
delivery: telegram
persistent_session: false
tools: [WebFetch]
enabled: true
---

Fetch https://news.ycombinator.com/news (the top page of Hacker
News). Pick the ONE story that's most relevant to a software
engineer / product person who cares about AI, developer tools,
or systems thinking. Skip pure crypto, drama, and political
posts.

Write a 3-bullet summary:
- **Story:** <title>, <source domain>, <points>, <comment count>
- **Why it matters:** one sentence on the actual signal
- **Whether to click:** "yes / skim the comments / skip" with
  one-sentence reasoning

Plain text, no markdown headers.
```

#### 5. Local weather + day brief

```yaml
---
id: weather-brief
name: Weather Brief
schedule: "15 7 * * *"
model: haiku
timeout_ms: 300000
delivery: telegram
persistent_session: false
tools: [WebSearch]
enabled: true
---

Use WebSearch to find today's weather for {{owner.city}}
(if you don't know the city, infer from {{owner.timezone}}).
Give a 1-line forecast: high/low, conditions, and any notable
event (rain, snow, heat warning). Then a one-sentence
"dress for" recommendation.

Total length: under 30 words.
```

Tip: this uses `{{owner.city}}` as a placeholder — that field isn't in
the default config, so either edit your prompt to hardcode your city
("Charlotte NC") or add `city` to your config under `owner:`.

#### 6. Wikipedia article of the day

```yaml
---
id: wiki-article-of-day
name: Wikipedia Article of the Day
schedule: "0 8 * * 6"
model: sonnet
timeout_ms: 300000
delivery: telegram
persistent_session: false
tools: [WebFetch]
enabled: true
---

Fetch https://en.wikipedia.org/wiki/Wikipedia:Today%27s_featured_article
and give a 4-sentence summary of the featured article: what it
is, why it's notable, one surprising detail, and a link.

Keep tone curious, not academic.
```

### Advanced — uses Gmail / Calendar (needs `harness google login`)

#### 7. Morning email triage

```yaml
---
id: email-triage
name: Morning Email Triage
schedule: "0 8 * * 1-5"
model: sonnet
timeout_ms: 600000
delivery: telegram
persistent_session: false
tools: [Bash]
enabled: true
gmail_subject: ""
---

Use the gog CLI (or shell out to your Google adapter) to fetch
unread emails from the last 24 hours. Group them into:

- **Reply today** — anyone you know expecting a response
- **Reply this week** — non-urgent but real
- **Skim** — newsletters, receipts, automated
- **Trash** — spam, unsubscribe candidates

Format each group with sender + subject + one-sentence summary
of why it's in that bucket. Be ruthless about "trash" — better
to suggest deletion than waste attention.

If there are zero emails in the "reply today" bucket, say so
explicitly with a single line. Don't pad.
```

> This recipe assumes you've installed a Google adapter shell-out tool
> like `gog`. The harness's built-in `src/adapters/google/` lives inside
> the Node process, not on PATH, so cron-side shell jobs need either
> their own Google tool OR to be written as Node-invoked cron jobs (a
> future enhancement).

#### 8. Calendar prep

```yaml
---
id: calendar-prep
name: Today's Calendar Prep
schedule: "0 7 * * 1-5"
model: sonnet
timeout_ms: 300000
delivery: telegram
persistent_session: false
tools: [Bash]
enabled: true
---

Pull today's calendar events (after 8 AM, before 6 PM) using
whatever Google adapter is configured. For each event:

- **<HH:MM>** **<title>** with <attendees if any>
- One sentence: what to prep, or "nothing — just show up"

End with one line: "Total meeting time today: X hours."

If today has no meetings, say so and stop.
```

### Creative / personal — reads your own wiki

#### 9. Habit check-in

First, create `personal/wiki/habits.md` with your tracked habits:

```markdown
# Habits
- exercise (3x/week target)
- read 30 min/day
- write morning pages (daily)
- no screens after 10pm (daily)
```

Then the cron job:

```yaml
---
id: habit-checkin
name: Habit Check-In
schedule: "0 21 * * 0"
model: sonnet
timeout_ms: 300000
delivery: telegram
persistent_session: false
tools: [Read]
enabled: true
---

It's Sunday evening. Read personal/wiki/habits.md. For each
habit, ask the user (in a single Telegram message) how they did
this week — but in a way that invites honest reflection, not
guilt. Don't ask "did you?" — ask "how did <habit> feel this
week?" or "what got in the way of <habit>?"

Keep the whole message under 8 lines. Number the questions.
Don't preamble; open with the first question.
```

#### 10. Reading recommendation from your interests

First, create `personal/wiki/interests.md`:

```markdown
# Interests
- agentic AI systems + multi-agent design
- product strategy for tools developers actually use
- writing that's plain but not stupid
- the history of how things actually got made
```

Then:

```yaml
---
id: weekly-reading-rec
name: Weekly Reading Recommendation
schedule: "0 10 * * 6"
model: opus
timeout_ms: 600000
delivery: telegram
persistent_session: false
tools: [Read, WebSearch]
enabled: true
---

Read personal/wiki/interests.md. Pick ONE specific article,
essay, or short book chapter the user should read this week
that intersects two or more of their interests in a
non-obvious way. Web-search to confirm the recommendation is
real (don't fabricate URLs).

Format:
**Read:** <title> by <author>, <source>, <year if known>
**Why this week:** one sentence connecting it to their interests
**Link:** <url>
**Time investment:** <minutes>

If nothing genuinely fits, say so — don't pad with a mediocre
pick.
```

#### 11. Decision-queue Sunday review

First, make sure `personal/wiki/decisions/` exists (the bot creates
dated decision files there when you ask it to). Then:

```yaml
---
id: decision-review
name: Sunday Decision Review
schedule: "0 19 * * 0"
model: opus
timeout_ms: 600000
delivery: telegram
persistent_session: false
tools: [Read, Glob, Grep]
enabled: true
---

Read every file in personal/wiki/decisions/ modified in the
last 14 days. Identify:

1. Any decision that's been deferred more than 7 days. Name it
   and suggest the smallest move toward closure.
2. Any decision that's "decided" but has no follow-through (no
   referenced action in personal/wiki/follow-ups.md).
3. Any decision that, with hindsight, looks like it was a bad
   call — and what the next decision should be.

Keep the message under 12 lines. If nothing in any category,
just say "decisions are healthy — nothing to flag" in one line.
```

#### 12. Monthly retro

```yaml
---
id: monthly-retro
name: Monthly Retro
schedule: "0 18 1 * *"
model: opus
timeout_ms: 900000
delivery: telegram
persistent_session: false
tools: [Read, Glob, Grep]
enabled: true
---

It's the 1st of the month. Look back at the previous calendar
month using:

- personal/wiki/log.md (chronological log of wiki edits)
- personal/wiki/decisions/ (decisions made)
- personal/wiki/follow-ups.md (what's open)

Write a tight retrospective:

**Three things that went well:**
1. <specific moment / decision / pattern>
2. ...
3. ...

**One thing that didn't:**
<specific, no euphemism>

**One question for next month:**
<concrete, scoped to the next 30 days>

No platitudes. Total length: under 20 lines.
```

---

## How to enable, disable, or test a job

### Enable / disable

Open the file, change `enabled: true` to `enabled: false` (or vice
versa). Save. Then:

```bash
pm2 restart claude-pmax-harness
```

The scheduler reloads jobs at start; the restart is required for
changes to take effect.

### Test a job right now (don't wait for the schedule)

```bash
npm run -s harness -- cron run <job-id>
```

The job fires immediately, exactly as if the scheduler had triggered it.
You'll see the result delivered the same way (Telegram, gmail, silent).
Use this to validate a job before letting it run on the schedule.

### See what's scheduled to fire next

```bash
npm run -s harness -- cron next
npm run -s harness -- cron next -n 20    # next 20 fires
```

### See what's run recently

```bash
npm run -s harness -- cron status
```

Shows the last 20 journal entries — when each job started, when it
finished, how long it took, and whether it succeeded.

---

## Common gotchas

### "My job doesn't fire at the time I expected"

Cron expressions are tricky. Verify with `harness cron next` — it tells
you exactly when the next fire is. If that's not what you intended, the
schedule string is wrong. Most likely causes:

- Day-of-week vs day-of-month confusion. Day-of-week is the LAST field
  (`0` = Sunday); day-of-month is the THIRD field.
- Forgetting timezone. The default is your config timezone. If you set
  the job's `timezone:` field, that overrides.

### "My job fires but the bot doesn't reply on Telegram"

Three possibilities, ranked by likelihood:

1. `delivery:` isn't `telegram`. Check the frontmatter.
2. The bot was offline at the fire time AND post-restart catch-up was
   suppressed. Check `harness cron status` — if the journal has no entry,
   it didn't fire. If it has a `success` entry but no Telegram
   delivery, check the bot's logs for send failures.
3. The job returned an empty response (or the literal `HEARTBEAT_OK`
   marker if you copied that pattern). The bot intentionally suppresses
   empty / OK-marker responses for `silent` jobs; for `telegram`,
   empty becomes "no response" which the harness still sends.

### "I keep getting two emails (or two Telegram messages) for the same job"

Probably ran the bot in two places at once, or restarted during a
fire window. The harness's `same-minute dedup` should prevent this
within a single scheduler instance — but if you start a second
instance via `npm run harness -- cron` while pm2's also running, you
have two schedulers competing. Use `pm2 status` to verify there's
only one process.

### "I changed `personal/cron/<id>.md` but the job still uses old behavior"

You need to restart the scheduler to pick up edits to existing jobs:

```bash
pm2 restart claude-pmax-harness
```

(The harness deliberately reads jobs at start, not per-fire — keeping
the runtime predictable.)

### "I'm worried about Pro Max budget"

Default to:

- **Haiku** for short / formatting jobs
- **Sonnet** for everything else
- **Opus** only for genuinely synthesis-heavy jobs (weekly reflection,
  monthly retro)

A daily Haiku job costs roughly nothing. A daily Opus job with web
search costs noticeably more. If you have 10+ daily jobs, glance at
`claude /usage` weekly.

To temporarily disable everything except chat:

```bash
# In personal/config.yaml:
assistant:
  heartbeat:
    enabled: false
# Then for each cron job, set enabled: false
pm2 restart claude-pmax-harness
```

---

## When you've outgrown this guide

- Read [`architecture.md`](./architecture.md) §17.3 for the full cron-runner
  internals (catch-up triple-check, retry, anti-self-talk directive, etc.)
- Read [`architecture.md`](./architecture.md) §13 for the locked design
  decision behind the markdown-frontmatter format.
- For more about what the bot can do beyond cron (chat use cases,
  brainstorming, file editing, etc.), see [`inspiration.md`](./inspiration.md).
