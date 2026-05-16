# Privacy

`claude-pmax-harness` runs locally on your machine and uses your Claude Pro Max
subscription via the Claude CLI. This page covers the privacy levers you have,
what each one controls, and what each one does NOT control.

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
- Local data (MemPalace, your wiki, your `personal/` directory) is on
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

## The local counterpart — purging your MemPalace

Anthropic's controls govern what Anthropic does with your data in
transit and at rest on their side. They do nothing about the verbatim
copy this harness keeps locally in MemPalace at
`~/.claude-pmax-harness/data/` (default, overridable with
`HARNESS_DATA_DIR`). That copy is *yours*, on *your* machine, and you
are responsible for it.

If you ever say something to the assistant you later regret — a
medical detail, a financial number, a relationship problem, anything —
the harness ships a purge command:

```
# Purge memories matching a semantic query (requires MemPalace 4.0+
# upstream support; until then, see workaround below)
harness memory purge --query "discussed my prescription"

# Purge memories in a date range (same upstream-support note)
harness memory purge --range 2026-04-01:2026-04-15

# Nuclear option — purge everything (asks for two-step confirmation)
harness memory purge --all
```

`--all` works today against any MemPalace version: the harness asks
you to type `yes` then `PURGE` and then either issues `purge_all` to
the bridge OR falls back to filesystem deletion of the MemPalace data
directory. Either way, your local store is gone.

`--query` and `--range` require MemPalace upstream to expose a
programmatic delete API. Until that lands, the workaround is `--all`
plus a fresh start, OR manually editing MemPalace's data directory
(advanced).

Wiki pages under `personal/wiki/` are plain markdown — edit or delete
them with any text editor. There is no separate tool needed.

Once you purge locally, those memories are gone from your store. They
may still exist on Anthropic's side under their retention policy — the
two stores are independent and need to be cleaned independently if you
care.

## PII guard rails

The harness has built-in tooling to help you avoid leaking PII into
shipped code or committed history:

- **`harness pii-check`** scans `personal/` for category-shaped strings
  (email, phone, address, calendar ID, financial). Reports counts +
  line numbers only — never the matched values themselves.
- **`harness pii-check --staged`** scans files staged for commit that
  live *outside* `personal/`. This is what the opt-in pre-commit hook
  calls.
- **`harness pii-check --install-hook`** installs an opt-in pre-commit
  hook into `.git/hooks/pre-commit` that runs the staged scan and
  blocks the commit on findings.
- **`personal/` is gitignored** by the framework's `.gitignore` so
  user content never accidentally ships in a fork.

The framework reads user content from `personal/` and nowhere else.
Any framework file referencing identity-shaped values (names, addresses,
emails, calendar IDs) is a defect — the `harness-skeptic` and
`harness-warden` agents catch this during review.

## Restricted chat mode

By default the chat allowlist includes `Bash`, `Write`, and `Edit` —
which means the assistant can execute shell commands and write files
on your machine when you chat with it via Telegram. That's powerful
and useful, but it's also implicit RCE for your bot owner.

If you'd rather not give the assistant those tools in chat:

```yaml
# personal/config.yaml
tools:
  allow_dangerous: false
```

This drops `Bash`, `Write`, and `Edit` from the chat allowlist. Cron
jobs still get the per-job `tools:` frontmatter, unaffected by this
flag — set per-job restrictions there.

## What this harness does NOT do

- It does **not** phone home. Ever. There is no telemetry, no error
  reporting, no anonymous usage stats. No opt-in/opt-out toggle for
  any of that — it's a hard line.
- It does **not** share your data with anyone other than the parties
  you've already configured (Anthropic via the Claude CLI; Telegram
  via your bot; optionally Google via your own OAuth client).
- It does **not** auto-update. You upgrade via `git pull`.

## Related controls worth knowing

- **Claude.ai's own conversation memory feature** — separate from this
  harness's memory system. Manage it under the same Privacy settings
  page on claude.ai.
- **Conversation export** — Anthropic provides a full export of your
  account data. Useful for audit or for migrating off.
- **Account deletion** — the full nuclear path. See claude.ai Privacy
  settings.

## Source of truth

Settings UIs and exact policy language change over time. The toggle is
the lever; these pages are authoritative on what it does today:

- https://privacy.anthropic.com
- https://www.anthropic.com/legal/privacy
- https://support.anthropic.com (search "training data" or "data controls")
