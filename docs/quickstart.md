# Quickstart

End-to-end install + setup walkthrough for a fresh machine. Assumes Linux
or macOS; WSL2 on Windows works too.

## 1. Prereqs

```bash
node --version       # need >= 20 (22+ recommended)
python3 --version    # need >= 3.11
claude --version     # need Claude CLI on PATH, authenticated against Pro Max
```

If any of those fail:

- **Node** — install via [nvm](https://github.com/nvm-sh/nvm) or
  [your OS package manager](https://nodejs.org/).
- **Python** — most distros have 3.11+ available. macOS via Homebrew:
  `brew install python@3.11`.
- **Claude CLI** — install + authenticate per [docs.claude.com](https://docs.claude.com/en/docs/claude-code/overview).
  You need a **Pro** or **Pro Max** subscription.

Also recommended:

```bash
npm install -g pm2   # for auto-restart on crash + boot
```

## 2. Clone + install

```bash
git clone https://github.com/<you>/claude-pmax-harness.git
cd claude-pmax-harness
npm install
```

## 3. Create your Telegram bot

You need a Telegram bot token from BotFather:

1. Open Telegram → start a chat with [@BotFather](https://t.me/botfather).
2. Send `/newbot`. BotFather asks for a name + username.
3. Save the **bot token** BotFather returns (format
   `123456789:AAEhBOweik6ad...`). You'll paste it into the wizard.
4. Send a `/start` to your new bot from your own Telegram account. Then
   open https://api.telegram.org/bot<TOKEN>/getUpdates in a browser and
   find your `chat.id` value in the response — that's your **chat ID**.
   (Or: run `harness setup --chat-id <id>` later if you know it.)

## 4. Run the setup wizard

```bash
npm run -s harness -- setup
```

The wizard walks you through:

- Privacy gate (offers a chance to read [`PRIVACY.md`](../PRIVACY.md))
- Prereq doctor (warn-only)
- Owner identity (your name, IANA timezone, what the assistant calls itself)
- MemPalace install (runs `scripts/install-mempalace.sh` into
  `~/.claude-pmax-harness/venv/` — uses ~200 MB disk for ChromaDB + deps)
- Telegram bot token + chat ID
- Google adapter opt-in (you can skip; configure later)
- Template rendering (Mustache fills `templates/*.template` into
  `personal/` with your values)
- Cron defaults (copies the 2 example jobs into `personal/cron/`)
- PII hygiene opt-ins
- Final `harness doctor` check

After the wizard:

- `personal/CLAUDE.md` — assistant identity (Claude CLI auto-discovers it)
- `personal/config.yaml` — runtime config (snake_case, schema in
  `src/config/schema.ts`)
- `personal/wiki/` — your durable, hand-curated context
- `personal/cron/` — your scheduled jobs (the 2 examples + anything you add)
- `.env` (chmod 600) — Telegram + Google secrets

Re-running `harness setup` is idempotent — it pre-fills from existing
state and skips files unless you pass `--force`.

## 5. (Optional) Google adapter

If you opted in to Google:

1. Go to https://console.cloud.google.com/
2. Create (or pick) a project.
3. APIs & Services → Library → enable Gmail API, Google Calendar API,
   Google Drive API.
4. APIs & Services → Credentials → Create credentials → OAuth client ID →
   Application type: **Desktop app**. Add `http://127.0.0.1` as an
   authorized redirect URI.
5. Copy the client ID + secret into `.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```
6. Run:
   ```bash
   npm run -s harness -- google login
   ```
   This opens a temp HTTP server on a free port; copy the printed URL into
   your browser, authorize, and the wizard captures + persists the
   refresh token. Then:
   ```bash
   npm run -s harness -- google test
   ```
   should show a green check for both Calendar and Gmail.

## 6. Verify everything is green

```bash
npm run -s harness -- doctor
```

You should see all checks PASS (or be honest about why not). The check list:

- node >= 20
- python3 >= 3.11
- claude CLI present
- .env file present (chmod 600)
- env vars valid
- personal/config.yaml loaded + validated
- data dir path
- MemPalace bridge ping
- MemPalace package installed

Anything that's FAIL has an actionable fix hint right under it.

## 7. Start the harness

Foreground (for testing):

```bash
npm run -s harness -- start
```

Production (auto-restart on crash):

```bash
pm2 start ecosystem.config.cjs
pm2 logs claude-pmax-harness
# For auto-start on machine boot:
pm2 startup    # follow the printed instructions
pm2 save
```

systemd alternative (power users):

```bash
mkdir -p ~/.config/systemd/user/
cp examples/systemd/claude-pmax-harness.service ~/.config/systemd/user/
# Edit ExecStart + WorkingDirectory in the file
systemctl --user daemon-reload
systemctl --user enable --now claude-pmax-harness.service
loginctl enable-linger $USER   # so it runs without an active session
```

## 8. Talk to your bot

Open Telegram, chat with your bot. The first message takes a bit (cold
start). Subsequent messages stream back.

Useful slash commands (sent in chat):

- `/start` — greeting + reset session
- `/clear` — clear conversation buffer for this chat
- `/errors` — recent error log entries (the last 5)
- `/lastlog` — recent response log entries
- `/clearerrors` — wipe the error log

## 9. Cron jobs

Two examples ship in `personal/cron/`:

- `morning-briefing.md` — fires at 07:30 in your TZ, sends a short
  briefing via Telegram.
- `weekly-reflection.md` — fires Sunday 20:00, sends a short reflection.

See `docs/cron-authoring.md` (TBD — coming in step 11 polish) for the
full frontmatter schema. Or read the example job files + `src/cron/types.ts`.

To add a job: drop a new `personal/cron/<id>.md` with the right frontmatter,
restart the harness. `harness cron list` confirms it loaded.

## 10. When things go wrong

- `harness doctor` is the first line of defense.
- `harness cron status` shows the last 20 journal entries.
- `pm2 logs claude-pmax-harness` (or `journalctl --user -u
  claude-pmax-harness`) for live logs.
- `harness pii-check` if you suspect you committed sensitive data.
- `harness memory purge --all` (two-step confirm) for a clean local
  slate.

If the bot stops responding, the wedge watchdog (§17.4 #1) should kick in
within 15 minutes and exit the process; pm2/systemd restarts it on a fresh
polling connection. If that doesn't happen, `pm2 restart claude-pmax-harness`
manually.

## 11. Privacy

Read [`PRIVACY.md`](../PRIVACY.md). The high-order bits:

- Toggle "Help improve Claude" off at https://claude.ai if you don't
  want your harness conversations used for training.
- `harness memory purge --all` clears your local MemPalace.
- `personal/` is gitignored — your content doesn't leak into a fork.
- The harness phones home to nothing.
