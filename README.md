# claude-pmax-harness

A harness for Claude Pro Max subscribers: companion chat over Telegram,
scheduled jobs (cron), and a Karpathy-style memory system (verbatim recall
via [MemPalace](https://github.com/MemPalace/mempalace) + synthesized wiki).
Runs locally on Linux / macOS / Windows-WSL2.

> **Status: v0.9-RC.** All 11 §16 implementation steps shipped + heartbeat +
> multi-modal extensions. 216 tests passing. Awaiting v1.0 ship gate: one
> external user runs ≥1 week without incident.

## New here? Start with one of these:

> **You only need the command line ONCE — to install.** After that, you
> manage everything by chatting with the bot in Telegram: scheduling
> recurring jobs, editing its personality, updating its notes, asking
> "what's running for me?" The terminal is the install path, not the
> usage path.

- **[`docs/quickstart.md`](./docs/quickstart.md)** — one-hour install
  walkthrough for true beginners. Covers WSL on Windows, Node + Python +
  Claude CLI install, BotFather setup, the wizard prompt-by-prompt,
  day-to-day pm2 operations, glossary.
- **[`docs/inspiration.md`](./docs/inspiration.md)** — "what to do with your
  bot." Starts with "managing your bot through chat" (cron jobs, personality,
  notes — all conversational), then nine more categories: research, writing,
  life admin, learning, brainstorming, decisions, code, memory, creative,
  health.
- **[`docs/cron-recipes.md`](./docs/cron-recipes.md)** — friendly tour of
  scheduled jobs. Leads with the "say X to your bot, it does Y" table for
  cron management. Cron-expression cheat sheet, recipe gallery of 12 example
  jobs you can ask for, file-format reference at the bottom for power users.

If you're a developer evaluating the architecture, jump to
[`docs/architecture.md`](./docs/architecture.md).

---

## What you'll have, when it's running

You have a Claude Pro Max subscription and a Telegram account. After running
`harness setup`, you have an assistant that:

- **Chats with you over a Telegram bot** you create at @BotFather.
  Single-user, single-machine, no multi-tenancy. Text, voice notes
  (transcribed locally), photos (Claude reads them via its multimodal
  Read tool), and documents.
- **Streams replies progressively** in Telegram as it thinks — you see
  the response build up, not a long pause and then a wall.
- **Remembers conversations** (MemPalace verbatim) and synthesizes durable
  knowledge into a Karpathy-style wiki at `personal/wiki/` that you and
  the bot both edit.
- **Runs scheduled jobs (cron)** that fire prompts and deliver results via
  Telegram, Gmail (with the optional Google adapter), or silently to disk.
  You set them up by **chatting with the bot** — no file editing needed.
- **Sends optional heartbeat nudges** every N hours (default 4) with quiet
  hours support, so the bot can surface follow-ups, calendar prep, or
  inbox urgency without waiting for you to ask. Off by default; opt in.
- **Manages itself from chat.** Tell it "set up X," "stop doing Y,"
  "tweak your personality to do Z" — the bot edits its own config + cron
  files and restarts itself. The CLI is the install path, not the daily
  driver.
- **Survives restarts, catches up on missed jobs, and self-heals** when
  things break. The resilience patterns are ported from a production-
  running sibling project with months of dated-incident lessons behind them.

## What it isn't

- Not multi-tenant. **Single-user, single-machine.**
- Not a SaaS. You run it yourself.
- No native Windows. WSL2 is the Windows path.
- No mobile app. Telegram is the interface.
- No Discord, Slack, or other channels (v2).
- No Claude API backend in v1 — uses the Claude CLI authenticated against
  your Pro Max subscription. (Pro Max economics are load-bearing.)
- **No telemetry. Ever.** No anonymous usage stats, no error reporting,
  no opt-in/opt-out toggle. Hard line.

---

## Prereqs at a glance

- **Claude Pro or Pro Max subscription** ($20/mo or $100–$200/mo)
- **Claude CLI** ([install](https://docs.claude.com/en/docs/claude-code/installation),
  then `claude` once to log in with your Pro/Max account)
- **Node.js 20+** (Node 22+ recommended; install via [nvm](https://github.com/nvm-sh/nvm))
- **Python 3.11+** (for the MemPalace bridge)
- **A Telegram account** + a bot token from [@BotFather](https://t.me/botfather)
- **pm2** recommended for auto-restart on crash (`npm install -g pm2`)
- **(Optional) Google Cloud project** with OAuth client + Gmail/Calendar/
  Drive APIs enabled, if you want the Google adapter

Full novice-friendly install walkthrough: [`docs/quickstart.md`](./docs/quickstart.md).

---

## Quickstart (terse version)

```bash
git clone https://github.com/carrickcarpenter/claude-pmax-harness.git
cd claude-pmax-harness
npm install
npm run -s harness -- setup        # interactive wizard
npm run -s harness -- doctor       # verify everything is green
# Optional: npm run -s harness -- google login   # for Gmail/Calendar adapter
# Optional: scripts/install-transcribe.sh        # for Telegram voice notes
pm2 start ecosystem.config.cjs
pm2 startup && pm2 save            # auto-restart on reboot
```

Talk to your bot on Telegram. Watch logs with `pm2 logs`. Send your bot
"set up a morning briefing at 7am every weekday" — it'll handle the rest.

---

## Running + restarting — cheat sheet

```bash
pm2 status                              # is the bot running?
pm2 logs claude-pmax-harness            # watch live logs (Ctrl-C to exit)
pm2 restart claude-pmax-harness         # restart (after config/template edits)
pm2 stop claude-pmax-harness            # stop (don't delete from pm2)
pm2 start claude-pmax-harness           # start after a stop
pm2 delete claude-pmax-harness          # unregister from pm2 entirely

cd ~/claude-pmax-harness && git pull && npm install \
  && pm2 restart claude-pmax-harness    # update to latest from GitHub

npm run -s harness -- doctor            # full health check
npm run -s harness -- cron list         # see scheduled jobs
npm run -s harness -- cron next         # see when each next fires
npm run -s harness -- cron status       # last 20 journal entries
npm run -s harness -- cron run <id>     # fire a single job right now
npm run -s harness -- memory stats      # MemPalace size + counts
npm run -s harness -- memory purge --all  # nuclear wipe (two-step confirm)

claude /usage                           # check your weekly Pro Max budget
```

In Telegram (sent to the bot):

```
/start          — greet + reset session
/clear          — clear this chat's conversation buffer
/errors         — last 5 errors
/lastlog        — last 5 responses + timing
/clearerrors    — wipe the error log
```

---

## Architecture

The full architecture spec is in [`docs/architecture.md`](./docs/architecture.md).
Highlights:

- **§9 LOCKED — single Node process** hosts the bot, cron scheduler, the
  heartbeat, and the MemPalace bridge child. pm2 supervises that one process.
- **§10 LOCKED — stateless per turn.** Every Claude invocation is a fresh
  `claude -p`. Implicit prompt caching (documented for Pro/Max) keeps the
  cost bounded.
- **§11 LOCKED — wiki-index pre-pass + hybrid MemPalace recall.** A short
  Claude pre-call picks which wiki pages are relevant; MemPalace recent-N
  + smart-search supplies conversation continuity.
- **§12 LOCKED — sync MemPalace writes.** If you saw the assistant's reply,
  MemPalace has the turn.
- **§13 LOCKED — markdown + YAML frontmatter** for cron job authoring.
  Matches Claude Code skill conventions.

§17 documents 70+ operational patterns ported from the sibling reference
codebase (resilience, error handling, multi-modal handlers, etc.). §18 is
the v1.0 ship-gate checklist.

---

## Privacy + safety

See [`PRIVACY.md`](./PRIVACY.md) for the full data-flow story, your
Anthropic privacy controls, the local-store ownership statement, and how
to purge MemPalace.

- **`personal/` is gitignored** at the framework repo. Your content stays yours.
- **`harness pii-check`** scans for category-shaped strings (counts only,
  never values).
- **Opt-in pre-commit hook** blocks PII-shaped strings from being committed
  outside `personal/`.
- **Restricted mode** (`tools.allow_dangerous: false`) drops `Bash`,
  `Write`, `Edit` from the chat allowlist.
- **No telemetry, ever.**

---

## CLI surface (complete)

```
harness setup       first-run wizard (idempotent — safe to re-run)
  --non-interactive             fail rather than prompt; combine with presets below
  --force                       overwrite existing personal/ files (with .bak sidecar)
  --chat-id <id>                preset: skip the chat_id prompt
  --owner-name <name>           preset: owner display name
  --timezone <tz>               preset: IANA timezone (e.g. America/New_York)
  --assistant-name <name>       preset: what the assistant calls itself
  --telegram-token <token>      preset: Telegram bot token
  --google                      preset: enable Google adapter opt-in
  --precommit-hook              preset: install PII pre-commit hook
  --no-allow-dangerous          preset: drop Bash/Write/Edit from chat tools

harness doctor      verify env / prereqs / config / perms
  --fix               auto-repair safe issues (chmod .env to 600)

harness start       run bot + cron + bridge + heartbeat (pm2/systemd invokes this)
harness bot         run ONLY the bot (mostly for dev)
harness cron        run ONLY the scheduler (mostly for dev)
  cron list         list discovered jobs
  cron run <id>     fire a job immediately, bypass schedule
  cron status       last 20 journal entries
  cron next [-n N]  next N fire times across all jobs

harness pii-check                       full personal/ scan
  pii-check --staged                    out-of-personal/ check (for hook)
  pii-check --install-hook              install pre-commit hook
  pii-check --uninstall-hook            remove pre-commit hook

harness memory stats                    MemPalace store stats
harness memory purge --all              nuclear wipe (two-step confirm)
harness memory purge --query <text>     (pending MemPalace upstream support)
harness memory purge --range FROM:TO    (pending MemPalace upstream support)

harness google login                    OAuth flow for Gmail/Calendar
harness google test                     verify Google connectivity

harness version                         versions of node / python / claude
```

---

## Acknowledgements

- Memory architecture inspired by Andrej Karpathy's
  [llm-wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).
- MemPalace: https://github.com/MemPalace/mempalace
- Telegram bindings: [grammY](https://grammy.dev/)

## License

MIT. See [`LICENSE`](./LICENSE).
