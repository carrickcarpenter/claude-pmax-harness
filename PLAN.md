# claude-pmax-harness — v1 Plan

A harness for Claude Pro Max users that adds a chat companion, scheduled jobs, and a memory system on top of the Claude CLI. Karpathy-style llm-wiki for synthesized state + MemPalace for verbatim recall. Telegram for chat. Pro Max subscription required.

This document is the brief for the next Claude Code session. It is intentionally self-contained — none of the prior conversation context is required to continue.

---

## Project goal (locked 2026-05-16)

claude-pmax-harness is an **open-source release for the global Pro/Max subscriber audience** — not a personal-project release. End users will install this on their own machines, point it at their own Telegram bot, and trust it with their data. That changes what v1 must guarantee:

1. **All best practices from the sibling reference implementation get ported** — but only as patterns, abstracted to remove any maintainer-specific content. See `docs/architecture.md` §17 for the catalog (70+ patterns).
2. **Strict PII discipline.** Zero personal data from the maintainer ships in templates, examples, or defaults. The framework reads user content from `personal/` and nowhere else. `harness pii-check` runs in framework CI as a hard gate.
3. **Safe to install and run.** End users should not fear losing their data or exposing their PII by following the quickstart. Defaults err conservative; risky operations require explicit opt-in.
4. **Stable on first release.** v1.0 is not "ship and iterate." The release-candidate checklist in `docs/architecture.md` §18.5 is the literal ship gate. If we can't get one external user through it successfully for ≥1 week, we don't tag 1.0.
5. **No telemetry, ever.** The harness phones home to nothing. Hard line.

`docs/architecture.md` §18 enumerates the non-negotiable PII / data-safety / stability guarantees this goal implies. The harness-skeptic agent (`.claude/agents/harness-skeptic.md`) reviews every non-trivial PR against this bar.

---

## Where we left off

Architecture phase complete as of 2026-05-16.

**Timeline:**
- Earlier: Scoping + decisions in an `~/alice-bot/` Claude Code session. `alice-skeptic` audit of the sibling codebase produced the high-level lessons captured in "Lessons from the prior audit" below.
- 2026-05-16: Architecture design pass in this project's session. Output: `docs/architecture.md` — 16 base sections + §17 (operational patterns, 70+ from a deeper Alice operational audit) + §18 (safety and stability commitments). §9 through §13 all LOCKED. Two custom agents in place: `.claude/agents/harness-skeptic.md` (project-scoped, framework deliverable) and `~/.claude/agents/pmax-cli-expert.md` (developer-scoped). Memory store at `~/.claude/projects/-home-carrickcarpenter-claude-pmax-harness/memory/` populated with project goal, audit boundary, Pro Max fundamentals, Alice pattern-source rules, user collaboration style.
- 2026-05-16: Project goal elevated (see above) — open-source-grade, PII-safe, stable-on-v1.

**Next step:** First-pass implementation. See `docs/architecture.md` §16 for the suggested order (doctor + config → bridge handshake → CLI wrapper → prompt assembly → bot → cron → PII tooling → setup wizard → Google adapter → pm2 + systemd → CI + docs). Every PR goes through `harness-skeptic` before merge; v1.0 ships only after the §18.5 release-candidate checklist is fully checked.

Suggested approach for the next session:
1. Read this entire `PLAN.md`, then `docs/architecture.md` §0 reading order.
2. Check the auto-memory at `~/.claude/projects/-home-carrickcarpenter-claude-pmax-harness/memory/MEMORY.md` for project state.
3. Pick the first implementation step from §16 and scope it as a PR. Invoke `harness-skeptic` before opening for review.

---

## What this is, what it isn't

**It is:** a runnable framework that someone with a Claude Pro Max subscription can clone, run a setup wizard against, point at a Telegram bot they create with BotFather, and get a chat companion with persistent memory + scheduled jobs.

**It isn't:** a fork of Alice. Alice is Carrick's personal assistant — different codebase, different repo, his life baked in. `claude-pmax-harness` is a generic framework. Patterns and capabilities from Alice port over; her personal content (cron jobs, wiki pages, MemPalace data, identity) does not.

**Inspiration:** Andrej Karpathy's [llm-wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). The dual-memory architecture (verbatim recall + synthesized wiki) is the strongest external positioning hook for this project.

---

## Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Repo strategy | Fresh `git init`, not a fork of any existing project | Cleaner history; Alice's tree contains personal data this project must not inherit |
| License | MIT | Lowest adopter friction; matches Karpathy gist conventions |
| Backend | Claude CLI + Pro Max only; no API path in v1 | Pro Max economics are load-bearing; API support adds substantial complexity (prompt caching, tool reimplementation, billing surprises) — deferred to v2 |
| Channel | Telegram-only, no abstraction layer | Premature abstraction has real cost; refactor when a second channel actually lands |
| Memory architecture | MemPalace verbatim + Karpathy-pattern wiki (dual system) | Verbatim and synthesized memory answer different questions; both required |
| Platform substrate | Native on Linux + Mac + WSL2; no Docker | Docker file-system access is too constrained for a harness users live inside |
| Process manager (recommended) | pm2 | Covers Linux + Mac with one tool (`pm2 startup` generates systemd/launchd under the hood) |
| Power-user alternative | Example systemd unit for Linux users who prefer it | Documented in `examples/`, not the happy path |
| Templating engine | Mustache for identity placeholders | Logic-less (safe in prompts), works inside markdown files, tiny dependency |
| Real customization model | Users open their fork in Claude Code and modify directly | Templating handles small identity knobs; everything else, the user hacks with Claude Code locally |
| Google integration | Included in v1 as optional adapter (Gmail + Calendar + Drive) | Target audience will want it; gated behind setup wizard prompt; harness runs fine without |
| Google library | Official `googleapis` Node SDK + `google-auth-library` OAuth | Not a port of `gog` (Carrick-private); fresh implementation |
| PII tooling | `harness pii-check`, `harness memory purge`, opt-in pre-commit hook, restricted chat mode | Built-in privacy levers, not optional add-ons |
| Privacy docs | `PRIVACY.md` ships with the framework | Threat model + Anthropic toggle + deletion semantics + MemPalace purge + what-not-to-prompt |
| Project name | `claude-pmax-harness` (slug); descriptive phrase as README tagline | Honest framing: "harness for Claude Pro Max" sets expectations correctly |

---

## v1 deliverables

- Telegram chat (`grammY`) with Claude CLI backend
- MemPalace verbatim memory + bridge process protocol (NDJSON over long-lived Python child)
- Karpathy-pattern wiki loader; ships with empty `identity.md.template`, `principles.md.template`, etc.
- Hardened cron runner: dedup, catch-up logic, journal-checking, retry, error-response detection
- Heartbeat (every N hours, quiet hours support) — **done 2026-05-16** (`src/heartbeat/`, wired in `harness start`, prompt template at `templates/heartbeat.md.template`)
- Generalized adversarial-subagent pattern (a `harness-skeptic` modeled on Alice's `alice-skeptic`)
- Optional Google adapter (Gmail + Calendar + Drive) via official Google SDK
- First-run setup wizard (`harness setup`): collects owner info, Telegram token, optionally walks through Google OAuth, generates `personal/` content from templates
- PII tooling: `harness pii-check`, `harness memory purge --query/--range/--all`, optional pre-commit hook, `tools.allowDangerous: false` mode
- 2 example cron jobs in `examples/cron/`: morning briefing (uses Calendar + Gmail), weekly reflection (pure-wiki)
- pm2 ecosystem config + example systemd unit in `examples/`
- `PRIVACY.md`, `README.md`, quickstart documentation
- GitHub Actions CI (lint + typecheck + test on Linux + Mac matrix)

---

## v2 / explicitly deferred

- Anthropic API backend (would unlock non-Pro-Max users)
- Additional channels: Discord, Slack
- Native Windows (WSL2 is the Windows path for v1)
- Native launchd plist templates (pm2 generates them under the hood already)
- Additional adapters beyond Google
- Multi-tenant support / household deployments
- A documentation site (README is v1; full docs site is later)

---

## PRIVACY.md draft

The draft below is the agreed-on content. Polish wording during v1 implementation; substance is locked.

```markdown
## Your Claude Pro Max privacy controls

This harness uses your Claude Pro Max subscription via the Claude CLI.
The privacy setting you choose at claude.ai applies to everything the
harness sends to Anthropic — chat messages, cron job prompts, MemPalace
context, every model invocation. There is no separate setting for the
harness itself; the claude.ai toggle IS the toggle.

### Turning off training data use

1. Go to https://claude.ai
2. Open your profile menu (bottom-left)
3. Navigate to Settings → Privacy (may appear as "Data Controls")
4. Find the "Help improve Claude" toggle
5. Turn it off

When this is off, Anthropic does not use your conversations to train
future Claude models. This is the most important privacy lever a Pro
Max user has, and it costs you nothing to flip.

### What this changes

- Off: your conversations are not used to train future models
- On: your conversations may be used to train future models

### What this does NOT change

- Anthropic still retains your conversations under their standard
  retention policy. This setting governs training use, not retention.
- Trust & Safety reviews still apply — Anthropic may flag specific
  content for human review regardless of this setting. This is a
  fixed policy boundary, not a user toggle.
- Local data (MemPalace, your wiki, your personal/ directory) is on
  your machine; the Anthropic toggle has no bearing on it. See "The
  local counterpart" below.

### Deleting conversations at claude.ai

Deleting a conversation in claude.ai removes it from your account view
and stops Anthropic from associating it with you going forward, but it
does not immediately purge the conversation from backend storage.
Standard retention windows still apply, and the conversation may persist
in backups for some period after deletion. If you want a clean account
slate, Anthropic provides a full account deletion path under the same
Privacy settings page — that triggers a different, more thorough
deletion flow.

The practical takeaway: delete is real, but not instant. Don't assume
that deleting a conversation 30 seconds before sharing your screen with
someone means they cannot in any theoretical scenario see it. If
something was genuinely sensitive, the time to think about it is before
you typed it, not after.

### The local counterpart — purging your MemPalace

Anthropic's controls govern what Anthropic does with your data in
transit and at rest on their side. They do nothing about the verbatim
copy this harness keeps locally in MemPalace at
`~/.claude-pmax-harness/data/`. That copy is *yours*, on *your*
machine, and you are responsible for it.

If you ever say something to the assistant you later regret — a
medical detail, a financial number, a relationship problem, anything —
the harness ships a purge command:

    # Purge memories matching a semantic query
    harness memory purge --query "discussed my prescription"

    # Purge memories in a date range
    harness memory purge --range 2026-04-01:2026-04-15

    # Nuclear option — purge everything (asks for confirmation)
    harness memory purge --all

Wiki pages under `personal/wiki/` are plain markdown — edit or delete
them with any text editor. There is no separate tool needed.

Once you purge locally, those memories are gone from your store. They
may still exist on Anthropic's side under their retention policy — the
two stores are independent and need to be cleaned independently if you
care.

### Related controls worth knowing

- **Claude.ai's own conversation memory feature** — separate from this
  harness's memory system. Manage it under the same Privacy settings
  page on claude.ai.
- **Conversation export** — Anthropic provides a full export of your
  account data. Useful for audit or for migrating off.
- **Account deletion** — the full nuclear path. See claude.ai Privacy
  settings.

### Source of truth

Settings UIs and exact policy language change over time. The toggle is
the lever; these pages are authoritative on what it does today:

- https://privacy.anthropic.com
- https://www.anthropic.com/legal/privacy
- https://support.anthropic.com (search "training data" or "data controls")
```

---

## PII patterns to teach users

The harness teaches PII hygiene through architecture, tooling, docs, and culture — four reinforcing layers.

### Architectural (built in, not optional)

1. **`personal/` directory convention.** Gitignored. All user identity, wiki content, custom prompts, custom cron jobs, custom skills live here. The framework code reads from nowhere else for user content. Upstream updates never touch it. User's mental model: *"if it's in personal/, it's mine."*
2. **MemPalace data lives outside the repo.** Default path `~/.claude-pmax-harness/data/`, not inside the cloned source tree. Avoids the "verbatim conversation DB committed to git" failure mode.
3. **`.env` is the only secrets boundary.** No secrets in unit files, no secrets in prompts, no secrets in skill files. Documented loudly.
4. **Restricted mode for chat tools.** Config flag `tools.allowDangerous: false` drops `Bash` and `Write` from the chat tool allowlist. For users who don't want the implicit RCE that comes with shell access in chat.

### Tooling

5. **`harness pii-check`.** Scans `personal/` and reports what *categories* of PII it sees (emails, phone numbers, addresses, calendar IDs, financial patterns). Doesn't dictate action; surfaces exposure.
6. **`harness memory purge`.** See PRIVACY.md draft above for invocation.
7. **Pre-commit hook (opt-in).** Warns when staged files outside `personal/` contain email-shaped, phone-shaped, or address-shaped strings.

### Documentation

8. **`PRIVACY.md`.** Threat model and Anthropic-toggle walkthrough (drafted above).
9. **"What NOT to put in prompts" page.** Concrete examples: third-party emails in BCC lists, family calendar IDs hardcoded in prompts, account numbers, children's info. Examples drawn from real failure modes.
10. **Two backup patterns documented, not chosen.** (a) Sync `personal/` to a private GitHub repo with git-crypt or sops for secrets. (b) Sync `personal/` to a cloud folder outside git. Tradeoffs of each. Don't bake either in.
11. **"The Open-Source Test" framing.** A reflective prompt: *"If I open-sourced my personal fork tomorrow, would I be comfortable with what's in here? If not, what would I move to personal/ or delete?"*

### Cultural

12. **Default identity template includes the "guest in your life" line.** Good prompt engineering; sets tone from minute one.
13. **Setup wizard asks about privacy explicitly.** First-run prompt: *"This harness will have access to your personal data. Want to read the privacy patterns guide before continuing? (y/N)"* — defaults to no for the rushed user, but the question itself plants awareness.

---

## Prerequisites for users

The README and quickstart should make these prerequisites explicit:

- **Claude Pro Max subscription** (verify Pro vs Pro Max CLI behavior before shipping)
- **Claude CLI** installed and authenticated (`claude` command on PATH)
- **Node 20+** (for the harness runtime)
- **Python 3.11+** (for the MemPalace bridge process)
- **Telegram bot token** from @BotFather (the user creates this themselves)
- **pm2** (recommended for autostart; `npm install -g pm2`)
- **(Optional) Google Cloud project + OAuth credentials** if using the Google adapter

---

## Lessons from the prior audit

A prior `alice-skeptic` audit ran against the Alice codebase to identify what to port and what to leave behind. Most findings became scope decisions above. Residual lessons that should shape implementation:

- **No template engine in Alice today.** This project must have one from day one (Mustache, per the decisions table). Every prompt that contains an identity-like value uses `{{owner.name}}`, `{{assistant_name}}`, etc.
- **Cron runner's dedup + catch-up logic is genuinely good.** Port the pattern: completed-today map, journal-checking fallback, gmail-checking fallback for email-sending jobs, error-response retry heuristic.
- **The `Bash` tool in the chat allowlist is full RCE for the bot owner.** Acceptable for default mode but must be loudly disclosed. Restricted mode is the user's escape hatch.
- **Per-message subprocess spawn is fragile under concurrency.** Document that the harness is single-user, single-machine. Don't pretend it scales.
- **Karpathy's `WIKI.md` schema doc is reusable as-is** with zero modifications — it's the only Alice file with no Carrick-specific content. Pull it directly when the wiki layer goes in.
- **`CLAUDE.md` auto-discovery is load-bearing for the CLI identity pattern.** The framework's `CLAUDE.md.template` plus the `personal/` overlay (the user's rendered `CLAUDE.md`) gives the same effect with proper genericization.

---

## Notes for the next Claude Code session

- This project lives at `~/claude-pmax-harness/`. Alice lives at `~/alice-bot/`. They are siblings. **Do not edit anything inside `~/alice-bot/` from this project's session.**
- This project has its own auto-memory store at `~/.claude/projects/-home-carrickcarpenter-claude-pmax-harness/memory/`. Build it up as needed, separately from Alice's memory.
- There is no `CLAUDE.md` yet at the project root. Add one when the project's collaboration patterns warrant it — not before. (The user's *rendered* `personal/CLAUDE.md` will exist after they run the setup wizard, but that's a runtime artifact, not a repo file.)
- Immediate next task: **architecture design.** Output target: `docs/architecture.md`. No code yet.
- The `Plan` agent is well-suited for the design pass.
