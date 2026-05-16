# claude-pmax-harness

A harness for Claude Pro Max subscribers: companion chat over Telegram,
scheduled jobs (cron), and a Karpathy-style memory system (verbatim recall
via [MemPalace](https://github.com/MemPalace/mempalace) + synthesized wiki).
Runs locally on Linux/macOS/WSL2.

> **Status: in development.** The architecture is locked, implementation is
> in progress. See [`docs/architecture.md`](./docs/architecture.md) §16
> "Implementation sequencing" for the current state per step.

## What it is

You have a Claude Pro Max subscription and a Telegram account. After running
`harness setup`, you have an assistant that:

- Chats with you over a Telegram bot you create at @BotFather. Single-user,
  single-machine, no multi-tenancy.
- Remembers conversations (MemPalace verbatim) and synthesizes durable
  knowledge into a Karpathy-style wiki at `personal/wiki/`.
- Runs scheduled jobs (cron) that fire prompts and deliver results via
  Telegram, Gmail (with the optional Google adapter), or silently to disk.
- Survives restarts, catches up on missed jobs, and self-heals when things
  break — the resilience patterns are ported from a production-running
  sibling project with months of dated-incident lessons behind them.

## What it isn't

- Not multi-tenant. **Single-user, single-machine.**
- Not a SaaS. You run it yourself.
- No native Windows. WSL2 is the Windows path.
- No mobile app. Telegram is the interface.
- No Discord, Slack, or other channels (v2).
- No Claude API backend in v1 — uses the Claude CLI authenticated against
  your Pro Max subscription. (Pro Max economics are load-bearing.)
- No telemetry. Ever.

## Prereqs

- **Claude Pro Max subscription** (verify Pro vs Pro Max CLI behavior
  before depending on this for production workloads)
- **Claude CLI** installed and authenticated (`claude` on `PATH`)
- **Node.js 20+** (Node 22+ recommended)
- **Python 3.11+** (for the MemPalace bridge)
- **A Telegram bot token** from [@BotFather](https://t.me/botfather)
- **pm2** is recommended for auto-restart (`npm install -g pm2`)
- **(Optional) Google Cloud project** with OAuth client + Gmail/Calendar/
  Drive APIs enabled, if you want the Google adapter

## Quickstart

See [`docs/quickstart.md`](./docs/quickstart.md) for a step-by-step walkthrough.
Short version:

```bash
git clone <this repo>
cd claude-pmax-harness
npm install
npm run -s harness -- setup
npm run -s harness -- doctor       # verify everything is green
# Optional: harness google login   # if you opted into the Google adapter
pm2 start ecosystem.config.cjs
pm2 startup && pm2 save            # auto-restart on reboot
```

Talk to your bot on Telegram. Watch logs with `pm2 logs`.

## Architecture

The full architecture spec is in [`docs/architecture.md`](./docs/architecture.md).
Highlights:

- **§9 LOCKED — single Node process** hosts the bot, cron scheduler, and the
  MemPalace bridge child. pm2 supervises that one process.
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
codebase (resilience, error handling, multi-modal, etc.). §18 is the v1.0
ship-gate checklist.

## Privacy + safety

[`PRIVACY.md`](./PRIVACY.md) covers the data flow, your Anthropic privacy
controls, the local-store ownership story, and how to purge MemPalace.

- **`personal/` is gitignored** at the framework repo. Your content stays
  yours.
- **`harness pii-check`** scans for category-shaped strings (counts only,
  never values).
- **Opt-in pre-commit hook** blocks PII-shaped strings from being committed
  outside `personal/`.
- **Restricted mode** (`tools.allow_dangerous: false`) drops `Bash`,
  `Write`, `Edit` from the chat allowlist.
- **No telemetry, ever.**

## CLI surface

```
harness setup       first-run wizard
harness doctor      verify env / prereqs / config / perms
harness start       run bot + cron + bridge (pm2/systemd invoke this)
harness bot         run ONLY the bot (mostly for dev)
harness cron        run ONLY the scheduler (mostly for dev)
  cron list         list discovered jobs
  cron run <id>     fire a job immediately
  cron status       last 20 journal entries
  cron next [-n N]  next N fire times across all jobs
harness pii-check                       full personal/ scan
  pii-check --staged                    out-of-personal/ check (for hook)
  pii-check --install-hook              install pre-commit hook
  pii-check --uninstall-hook            remove pre-commit hook
harness memory stats                    MemPalace store stats
harness memory purge --all              nuclear wipe (two-step confirm)
harness memory purge --query / --range  (pending MemPalace upstream)
harness google login                    OAuth flow for Gmail/Calendar
harness google test                     verify Google connectivity
harness version                         versions of node / python / claude
```

## Acknowledgements

- Memory architecture inspired by Andrej Karpathy's
  [llm-wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).
- MemPalace: https://github.com/MemPalace/mempalace
- Telegram bindings: [grammY](https://grammy.dev/)

## License

MIT. See [`LICENSE`](./LICENSE).
