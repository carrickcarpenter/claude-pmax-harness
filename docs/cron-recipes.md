# Scheduled jobs — talk to your bot, it does the rest

You don't need to know what cron is or open a terminal. Your bot can set
up, list, modify, test, and delete scheduled jobs for you — just by chat.

This page teaches you what to say. The terminal commands and file format
are at the bottom for power users.

---

## How to ask

Open your Telegram chat with the bot and say things like:

| You say | What the bot does |
|---|---|
| "Send me a morning briefing every weekday at 7am" | Drafts a `personal/cron/weekday-morning-briefing.md`, shows you the prompt before saving, asks if you want changes, then tests it once and confirms when the first real fire will happen |
| "What's scheduled for me right now?" | Lists every active job with its schedule + delivery |
| "When does my morning briefing fire next?" | Shows the next several fire times |
| "Show me what my morning briefing looks like — fire it now" | Runs the job immediately so you see today's output |
| "The morning briefing is too long — make it 3 lines" | Edits the prompt body, restarts the scheduler |
| "Stop the morning briefing for a week" | Sets it to disabled and reminds you how to re-enable |
| "Set up a Friday-evening 'plan the weekend' nudge for me" | Same as the first row, but Friday at 5pm |
| "Did the morning briefing run today?" | Reads the journal, tells you yes/no with timing |
| "Delete the morning briefing" | Confirms once, then removes the file and restarts |

The bot is **expected** to:

1. Ask clarifying questions if the timing or content is vague ("morning"
   isn't a time; "every Friday" leaves the time open).
2. Show you the proposed prompt body before saving so you can edit it.
3. Run the job once via `harness cron run <id>` so you see the actual
   output before letting it run on schedule.
4. Restart the scheduler (a quick automatic step) so changes take effect.
5. Confirm what was set up and when it'll first fire.

If the bot DOESN'T do those things, push back: "Show me the prompt
before you save." It'll comply.

---

## A 60-second cron concept primer

This is just enough vocabulary to converse with your bot meaningfully.
You don't have to memorize syntax — the bot handles that.

**A "cron job"** is a prompt your bot runs on a schedule. The bot wakes
up at the time you specified, runs the prompt, and delivers the result
(usually as a Telegram message).

**The schedule** is a 5-field expression in the bot's brain. You don't
write it; the bot translates plain English into it. Examples it knows:

- "every day at 7am" → `0 7 * * *`
- "weekdays at 8am" → `0 8 * * 1-5`
- "every Sunday evening at 8" → `0 20 * * 0`
- "1st of every month at 9am" → `0 9 1 * *`
- "every 15 minutes" → `*/15 * * * *` (rarely needed; ask why first)

**Delivery** is where the result goes. Default is Telegram. Other options
are `silent` (just runs, doesn't message you) and `gmail` (sends email
via the Google adapter, if you've set that up).

**The model** is which Claude does the work. Cheaper models are faster
and cost less of your Pro Max budget; smarter models cost more. The bot
defaults to:
- `haiku` for short formatting jobs
- `sonnet` for most things
- `opus` only for genuinely deep weekly/monthly reflection

You can override: "Use Opus for this — I want a deep weekly retro."

**Enabled** means the job actually runs on the schedule. Disabling
keeps the file around but skips it. Useful for muting a job temporarily.

---

## Inspiration gallery — things to ask for

Twelve example jobs across difficulty tiers. Say the prompt to your bot
in chat; it will handle the setup. If you want to write the file
yourself, the bottom of this doc has the underlying format.

### Easy — no extra setup needed

#### "Send me a 'today in history' snippet every morning at 8"
The bot pulls one interesting event from training data — no web needed.

#### "On Fridays at 4pm, ask me what I want to do this weekend"
Reads your wiki for hanging follow-ups + suggests one specific weekend move.

#### "Monday mornings at 7:30, send me one sentence to set the week"
Reads your `personal/wiki/identity.md` + `principles.md` and composes a
one-sentence intention. Sounds like you, not a fortune cookie.

### Medium — uses web search or fetch (no extra setup)

#### "Each morning at 7, send me the top Hacker News story that matters to me"
Fetches HN front page, picks ONE story relevant to your interests, gives
3-bullet summary + "click / skim comments / skip" verdict.

#### "Tell me today's weather and what to wear at 7:15"
WebSearches your city's forecast, one-line summary + dress-for note.

#### "Saturday at 8, send me Wikipedia's featured article of the day"
Fetches Wikipedia's featured article and gives a 4-sentence summary.

### Advanced — needs Gmail/Calendar (run `harness google login` first)

#### "Weekday mornings at 8, triage my inbox for me"
Pulls last-24h unread, groups into Reply today / Reply this week / Skim /
Trash. Ruthless about Trash.

#### "At 7am weekdays, prep me for today's calendar"
For each meeting today: title, attendees, one-sentence "what to prep" or
"just show up."

### Creative — reads your wiki

#### "Sunday evening at 9, check in on my habits"
Reads `personal/wiki/habits.md`, asks open-ended questions about each habit
that invite reflection (not guilt).

#### "Saturday at 10am, recommend something for me to read this week"
Reads `personal/wiki/interests.md`, picks ONE article/essay/chapter that
intersects two interests in a non-obvious way. Web-searches to confirm
it's real.

#### "Sunday at 7pm, review my open decisions"
Reads `personal/wiki/decisions/`, flags ones deferred too long or with
no follow-through.

#### "1st of each month at 6pm, do my monthly retro"
Reads `wiki/log.md`, `wiki/decisions/`, `wiki/follow-ups.md` for the
prior month. Writes: three wins, one miss, one question for next month.
No platitudes.

---

## Asking the bot to help you discover what's possible

If you're not sure what to ask for, send:

> "What kinds of scheduled jobs make sense for me, given what you know
> about me? Suggest three that would actually be useful, not generic."

The bot will pull from your wiki and propose specific ones tailored to
you. You pick, it builds. This is the highest-leverage move on this page.

---

## Common gotchas (when you're chatting with the bot)

### "I asked for a job but I'm not sure if it's running"

Send: "Did <job name> run today?" or "When does <job name> fire next?"

The bot reads the journal + computes the next fire and tells you.

### "The job fires at the wrong time"

Send: "<job name> fires at the wrong time. I want X, not Y."

The bot edits the schedule, restarts, confirms.

### "The job's output is too long / too short / wrong tone"

Send: "Make <job name> shorter — 3 lines max" or "less formal" or
"include a one-line recommendation at the end."

The bot edits the prompt body. Ask it to "fire it now" to verify the
change works before letting it run on schedule.

### "I want to stop all my jobs for a vacation"

Send: "I'm on vacation until <date>. Pause all my scheduled jobs and
resume them when I'm back."

The bot disables each job, sets a reminder in `wiki/follow-ups.md` for
your return date to re-enable.

### "I'm worried about how much these jobs are costing"

Send: "How much of my Pro Max budget am I using? Which jobs are the
expensive ones?"

The bot runs `claude /usage` and the cron journal, summarizes weekly
spend by job. May suggest downgrading some `opus` jobs to `sonnet`.

---

## Manual / power-user reference

Everything below is for users who want to write or edit the cron files
themselves, or understand what the bot is doing under the hood. **You
don't need any of this to use the bot.**

### Where the files live

Each cron job is a markdown file in `~/claude-pmax-harness/personal/cron/`.
The file name is up to you; the bot uses lowercase kebab-case
(`morning-briefing.md`, `weekday-hn-brief.md`).

### The frontmatter schema

Every cron job has a YAML frontmatter block at the top. Full schema:

```yaml
---
id: morning-briefing                # short, unique, lowercase kebab-case
name: Morning Briefing              # human-readable; used in alerts
schedule: "30 7 * * *"              # 5-field cron expression
timezone: "America/New_York"        # optional; defaults to your config TZ
model: sonnet                       # haiku | sonnet | opus
timeout_ms: 600000                  # max wall-clock time (ms); default 600000 (10 min)
delivery: telegram                  # telegram | gmail | silent
persistent_session: false           # almost always false (see warning)
tools: [Read, Glob, Grep, WebSearch]  # which tools Claude can use
enabled: true                       # set false to skip without deleting
gmail_subject: "Morning Briefing"   # optional; only for delivery: gmail
---

(your prompt body goes here)
```

Field notes:

- **`id`** — internal name. Used in logs and `harness cron run <id>`.
  Don't change after a job has fired; the catch-up system uses it.
- **`model`** — pick the cheapest model that does the job. Daily Opus
  jobs add up fast on the Pro Max budget.
- **`timeout_ms`** — kill the job after this many milliseconds. 5 min =
  `300000`, 10 min = `600000`, 30 min = `1800000`.
- **`delivery: gmail`** — the job ITSELF needs to send the email via
  the Google adapter; cron just acknowledges. Set `gmail_subject:` so
  the catch-up check can verify it sent.
- **`persistent_session`** — leave `false` 99% of the time. Setting
  `true` causes context bleed across runs (the job remembers stale data
  it shouldn't).
- **`tools`** — narrow this to what the job actually needs. Tools the
  bot doesn't use cost nothing, but reducing surface is cleaner.

### Cron expression cheat sheet

```
* * * * *
│ │ │ │ │
│ │ │ │ └── day of week (0–6, 0 = Sunday)
│ │ │ └──── month (1–12)
│ │ └────── day of month (1–31)
│ └──────── hour (0–23)
└────────── minute (0–59)
```

| Pattern | Meaning |
|---|---|
| `30 7 * * *` | every day 7:30 AM |
| `0 9 * * *` | every day 9:00 AM |
| `0 8 * * 1-5` | weekdays 8:00 AM |
| `0 18 * * 0` | every Sunday 6:00 PM |
| `0 9 * * 6` | every Saturday 9:00 AM |
| `*/15 * * * *` | every 15 minutes |
| `0 * * * *` | top of every hour |
| `0 9 1 * *` | 1st of every month at 9:00 AM |
| `0 12 * * 1,3,5` | Mon/Wed/Fri at noon |

Times are in your config's timezone unless you override per-job.

### Terminal commands (for the curious)

```bash
# See all your jobs
npm run -s harness -- cron list

# See when each one fires next (across all jobs, chronological)
npm run -s harness -- cron next
npm run -s harness -- cron next -n 20

# Fire a single job right now (bypass the schedule)
npm run -s harness -- cron run <job-id>

# See recent journal entries (success/failure history)
npm run -s harness -- cron status

# Reload the scheduler after editing a job file
pm2 restart claude-pmax-harness
```

### Tutorial — write a cron job manually

If you'd rather edit the file yourself (or you want to understand what
the bot is generating):

1. Create the file at `~/claude-pmax-harness/personal/cron/<id>.md`.
2. Paste in a frontmatter block + prompt body (use any recipe above as a
   template).
3. Restart: `pm2 restart claude-pmax-harness`.
4. Test: `npm run -s harness -- cron run <id>`.
5. The job will now fire on its schedule. `harness cron next` confirms.

### When you've outgrown this guide

- [`architecture.md`](./architecture.md) §17.3 — full cron-runner
  internals (catch-up triple-check, retry, anti-self-talk directive,
  tick-stall watchdog).
- [`architecture.md`](./architecture.md) §13 — the locked design
  decision behind the markdown-frontmatter format.
- [`inspiration.md`](./inspiration.md) — what to do with your bot
  beyond scheduled jobs (chat, brainstorming, decisions, etc).
