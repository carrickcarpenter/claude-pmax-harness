# Quickstart — install your bot in one hour

This guide assumes you have a Claude Pro or Max subscription and want a
personal AI assistant on Telegram, but you've never set up a Node.js
project before. We'll start from scratch.

Estimated time: about 60 minutes the first time. Most of it is waiting
for downloads.

---

## What you're building

By the end of this guide you'll have:

- A Telegram chat with a bot you talk to like any other contact. The bot
  is powered by Claude (via your Pro or Max subscription) and remembers
  your conversations.
- A "personal directory" on your computer that holds your bot's identity,
  notes, and scheduled jobs. Only you can see it.
- A few scheduled "cron jobs" that fire on a schedule — for example, a
  morning briefing at 7:30 AM. You can add, remove, or edit these whenever
  you want.
- Optional: integration with Gmail and Google Calendar so the bot can
  read your email and your schedule.

The bot runs locally on your machine. Nothing about it phones home.
Anthropic sees only the conversations you have with the bot (same as if
you used claude.ai directly). The bot's memory lives on your machine; you
can wipe it at any time.

---

## Step 0 — will this work on my computer?

You need **one** of these:

- **Linux** (Ubuntu, Debian, Fedora, Arch — any modern distro)
- **macOS** (12 Monterey or newer)
- **Windows 10 or 11** with **WSL2** (Windows Subsystem for Linux) installed.
  This is free, made by Microsoft, and turns your Windows machine into a
  Linux machine for the purposes of running the harness. We'll install
  WSL2 in Step 1 if you don't have it.

You do **not** need a powerful machine. Anything that can run a browser
will run the bot. The bot uses Anthropic's servers for the actual AI
work — your computer is just the orchestrator.

You also need:

- **A Claude Pro or Pro Max subscription.** ($20/mo for Pro, $100 or $200/mo
  for Max.) Pro Max gives you much more headroom; if you plan to use the
  bot heavily, Max is the better fit. You can start on Pro and upgrade.
- **A free Telegram account** (mobile app or desktop).
- **About 1 GB of free disk space** for Node.js, Python, the harness, and
  Claude's memory store.

---

## Step 1 — install the operating-system prereqs

You only do this once per computer.

### If you're on Windows

You need WSL2 first. Open **PowerShell as Administrator** (right-click
the Start menu → "Windows PowerShell (Admin)" or "Terminal (Admin)"):

```powershell
wsl --install
```

Restart your computer when it tells you to. After restart, Ubuntu opens
in a new window and asks you to pick a Linux username and password. Pick
anything — write it down.

From this point forward, **everything in this guide happens inside that
Ubuntu window, not in PowerShell**. Open it by typing "Ubuntu" in your
Start menu.

> **What is WSL2?** A way to run Linux programs on Windows. Microsoft
> ships it. The harness runs inside it; you ignore Windows for everything
> harness-related.

### If you're on macOS

Open **Terminal** (Cmd-Space → "Terminal"). You're ready for the next
section. If you've never used the command line on macOS before, this is
where you'll type commands.

### If you're on Linux

Open your terminal. You know the drill.

---

## Step 2 — install Node.js, Python, and the Claude CLI

These are the three tools the harness needs to run. We'll install them
inside your terminal.

### Install Node.js (version 20 or newer)

The easiest way is via **nvm** (Node Version Manager), which lets you
install and switch Node versions without sudo:

```bash
# Download + run the nvm installer
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# Close + reopen your terminal so nvm is loaded
# Then install the latest stable Node 22:
nvm install 22
nvm use 22

# Verify
node --version    # should print v22.x.x or newer
```

### Install Python (version 3.11 or newer)

Most modern systems already have it. Check:

```bash
python3 --version    # need 3.11 or newer
```

If you get an error or an older version:

- **WSL2 / Ubuntu:**  `sudo apt update && sudo apt install -y python3.12 python3.12-venv python3-pip`
- **macOS:**  `brew install python@3.12` (install Homebrew first from https://brew.sh if you don't have it)
- **Fedora:**  `sudo dnf install -y python3.12`

After installing, re-run `python3 --version` to confirm.

### Install the Claude CLI

This is Anthropic's official command-line tool. The bot talks to Claude
through it. Install instructions:

https://docs.claude.com/en/docs/claude-code/installation

Pick the method for your OS (likely a one-line `curl ... | sh` or a
Homebrew formula). After install, verify:

```bash
claude --version    # should print 2.x.x or newer
```

### Log in to Claude with your Pro/Max account

```bash
claude
```

The first time you run `claude`, it walks you through authentication. A
browser tab opens; log in with your Anthropic account (the one your
Pro/Max subscription is on). When it returns to the terminal, you're
authenticated. Type `/exit` to quit; the bot will use this auth
automatically from now on.

> **Test it:** Run `claude -p "say hi in five words"`. You should get a
> short reply. If you get a billing error, your subscription isn't
> attached correctly — check at https://claude.ai/.

### Install pm2 (recommended — keeps your bot running)

pm2 is a "process manager" — it restarts the bot if it crashes and lets
you check on it with simple commands.

```bash
npm install -g pm2
pm2 --version    # should print 5.x.x or newer
```

> **Why pm2?** Without it, when you close your terminal the bot stops.
> With it, the bot keeps running in the background and restarts itself
> if it crashes.

---

## Step 3 — create your Telegram bot

Open Telegram (any device) and start a chat with **@BotFather**
([t.me/botfather](https://t.me/botfather)). BotFather is Telegram's
official bot for creating bots — it's run by Telegram itself.

1. Send `/newbot`
2. BotFather asks for a display name — pick anything (e.g. "Sage", "My
   Helper", "Jeeves"). This is what the bot is called in your contacts.
3. BotFather asks for a username — must end in `bot` (e.g. `sage_helper_bot`).
   Must be globally unique; you may need to try a few.
4. BotFather replies with a long string like
   `123456789:AAHkpzMHb-aBcDeFgHiJkLmNoPqRsTuVwXy` — that's your **bot
   token**. Save it somewhere safe. You'll paste it into the harness in
   Step 5.

Now find your own **chat ID** (Telegram's internal user number — the bot
needs this so it knows to only listen to you):

1. Search Telegram for your new bot by username (the one ending in `bot`).
2. Open a chat with it. Send any message (e.g. "hello").
3. In a browser, open: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   (paste your token in place of `<YOUR_TOKEN>`)
4. Find `"chat":{"id":NNNNNNNNN,...}` in the response. The `NNNNNNNNN`
   number is your chat ID. Save it.

> **Skip this if it's awkward:** the harness setup wizard accepts a
> `--chat-id` flag and you can finish this step after install. The wizard
> will tell you exactly what to do.

---

## Step 4 — clone the harness and install its dependencies

Back in your terminal:

```bash
# Pick a home for the harness. Your home directory is fine.
cd ~

# Download the code
git clone https://github.com/carrickcarpenter/claude-pmax-harness.git
cd claude-pmax-harness

# Install all the Node.js dependencies the harness needs
npm install
```

The `npm install` step takes 30–60 seconds and prints a lot of text. It's
done when you get your command prompt back.

> **What did that do?** `git clone` copies the harness's source code from
> GitHub to your computer. `npm install` reads `package.json` and
> downloads every library the harness needs (grammY for Telegram,
> Mustache for templates, zod for config validation, etc.) into a
> `node_modules/` folder. You only run this once per install.

---

## Step 5 — run the setup wizard

```bash
npm run -s harness -- setup
```

The wizard walks you through every value it needs. Here's what each
prompt asks and what to type:

1. **"Read PRIVACY.md before continuing?"** — `n` is fine (you can read
   `PRIVACY.md` whenever; it doesn't change anything).
2. **Prereq check runs** — should show all PASS for node/python/claude.
   If any FAIL, fix that before continuing (see Step 2).
3. **"Your name?"** — Type your first name (e.g. `Sam`). Used in the
   bot's prompts.
4. **"Your IANA timezone?"** — Like `America/New_York`, `Europe/London`,
   `Asia/Tokyo`. If unsure, type it as `Continent/City`. Hit enter to
   accept the default if shown.
5. **"What should the assistant call itself?"** — Pick a name. This is
   how the assistant refers to itself ("I'm Sage"). Examples: `Sage`,
   `Mira`, `Atlas`, `Echo`, `Jeeves`.
6. **MemPalace installs** — this is the bot's memory system. Takes 1–3
   minutes the first time; downloads about 300 MB of Python packages
   into `~/.claude-pmax-harness/venv/`. You'll see pip output scroll by.
7. **"Telegram bot token?"** — paste the long string from BotFather (the
   one from Step 3).
8. **"Your Telegram chat ID?"** — paste the number from Step 3.
9. **"Enable Google integration?"** — `n` for now. (You can add Gmail
   and Calendar later with `harness google login` — see "Going further".)
10. **"Install opt-in pre-commit hook?"** — `n` unless you're a
    developer planning to modify the harness source.
11. **"Allow dangerous chat tools?"** — `y` if you trust the bot with
    shell access (it can run any command on your computer when you ask
    it to in chat). `n` for restricted mode (the bot can read files +
    search the web but can't write or run commands).
12. **Summary screen + doctor re-run** — should end with most checks
    PASS.

After this finishes, you have:

- `~/claude-pmax-harness/personal/CLAUDE.md` — your bot's identity (you
  can edit this anytime to tweak its personality)
- `~/claude-pmax-harness/personal/wiki/` — where the bot stores
  long-term notes about you
- `~/claude-pmax-harness/personal/cron/` — folder for scheduled jobs
- `~/claude-pmax-harness/.env` — your secret tokens (Telegram, Google
  if enabled). Never share or commit this file.

---

## Step 6 — verify everything is green

```bash
npm run -s harness -- doctor
```

You want to see PASS lines for everything:

```
[PASS] node >= 20
[PASS] python3 >= 3.11
[PASS] claude CLI present
[PASS] .env file present
[PASS] .env permissions (600)
[PASS] env vars valid
[PASS] personal/config.yaml
[PASS] data dir path
[PASS] MemPalace bridge ping
[PASS] MemPalace package installed
```

If any are FAIL, the message includes a fix hint right under it. The
most common is `.env permissions (600)` — fix with:

```bash
npm run -s harness -- doctor --fix
```

---

## Step 7 — start your bot

```bash
pm2 start ecosystem.config.cjs
pm2 logs claude-pmax-harness
```

You should see lines like:

```
[start] MemPalace bridge ready
[bot] online as @your_bot_username
[start] cron scheduler started
```

If you see those three, **the bot is alive**. Press Ctrl-C to stop
watching the logs (the bot keeps running in the background).

### Make the bot start automatically on reboot

```bash
pm2 startup       # follow the instructions it prints
pm2 save
```

After this, the bot survives reboots. Without it, you'd have to run
`pm2 start ecosystem.config.cjs` after every restart.

---

## Step 8 — talk to your bot

Open Telegram, find your bot (search by the username ending in `bot`),
and send a message. The first reply takes a few seconds (cold start).
Subsequent replies stream back as the bot thinks.

Try:

- "Hi" — quick smoke test
- "What can you do?" — the bot describes itself based on its CLAUDE.md
- "Remember that my dog's name is Rex" — saves into MemPalace
- "What's my dog's name?" (later) — bot recalls from MemPalace
- "Look up today's weather for my city" — bot uses WebSearch tool
- "Help me draft a thank-you note to a friend" — open-ended creative

If the bot doesn't reply: check `pm2 logs claude-pmax-harness` for
errors. See the troubleshooting section at the end.

---

## Day-to-day operations

### See the bot's status

```bash
pm2 status
```

You'll see a table. The bot's row should show `status: online`.

### Watch live logs

```bash
pm2 logs claude-pmax-harness
```

Press Ctrl-C to stop watching (the bot keeps running).

### Restart the bot

```bash
pm2 restart claude-pmax-harness
```

Use this if the bot is acting strange or you've changed
`personal/CLAUDE.md` or `personal/config.yaml`.

### Stop the bot

```bash
pm2 stop claude-pmax-harness
```

The bot stops responding on Telegram but pm2 still knows about it (start
again with `pm2 start claude-pmax-harness`).

### Remove the bot from pm2 entirely (advanced)

```bash
pm2 delete claude-pmax-harness
```

This unregisters the bot from pm2. The bot's data and config stay; you
can start it again with `pm2 start ecosystem.config.cjs` from the repo
dir.

### See what the bot thinks went wrong today

From inside Telegram, send the bot:

- `/errors` — last 5 errors
- `/lastlog` — last 5 turns + how long each took
- `/clear` — reset this chat's conversation history (the bot forgets
  what you just talked about)
- `/clearerrors` — wipe the error log

### Update the bot to the latest version

```bash
cd ~/claude-pmax-harness
git pull
npm install      # only if package.json changed
pm2 restart claude-pmax-harness
```

The `git pull` step downloads any new code from GitHub. The bot picks
up the new code after the restart.

### See how much of your Pro Max budget you've used today

The `claude` CLI itself has this:

```bash
claude /usage
```

This tells you what fraction of your weekly limit you've spent. If it's
high, dial back: disable cron jobs you don't need (`enabled: false` in
the job's frontmatter), or set heartbeat to `enabled: false`.

---

## Going further

### Adding daily routines (cron jobs)

See [`cron-recipes.md`](./cron-recipes.md) for a friendly walkthrough of
the cron-job format plus a gallery of example jobs across difficulty
tiers, from "daily wisdom quote" to "weekly portfolio summary." That
doc teaches you everything you need to author your own.

### What can your bot actually do?

See [`inspiration.md`](./inspiration.md) for a gallery of things you can
ask your bot — in chat AND as cron jobs. Helps you discover what a
personal AI assistant on your machine is actually good at.

### Adding Gmail + Calendar

If you want the bot to read your email or check your calendar:

1. Go to https://console.cloud.google.com/
2. Create a project, enable Gmail API + Calendar API.
3. Create OAuth credentials (Desktop app).
4. Add `GOOGLE_CLIENT_ID=...` and `GOOGLE_CLIENT_SECRET=...` to
   `~/claude-pmax-harness/.env`.
5. Run: `npm run -s harness -- google login`
6. A browser tab opens; authorize; you're done.
7. Run `npm run -s harness -- google test` to verify.
8. Restart the bot: `pm2 restart claude-pmax-harness`

Now your bot can read your inbox + calendar via chat or cron.

### Editing your bot's personality

Open `~/claude-pmax-harness/personal/CLAUDE.md` in any text editor (e.g.
`nano personal/CLAUDE.md` or open it in VS Code with `code .`). The
bot reads this file at the start of every conversation. Edit anything —
tone, areas of focus, what to remember, what to ignore. Restart the bot
after changes.

### Editing the bot's notes (wiki)

The bot maintains a "wiki" of long-term knowledge about you at
`~/claude-pmax-harness/personal/wiki/`. You can edit those files
directly (any markdown editor), or let the bot edit them when you ask
it to in chat ("remember this: ..." or "update your notes on X").

---

## Troubleshooting

### "`harness setup` says I need a bot token but I don't have one"

You skipped Step 3. Go back, talk to @BotFather, get a token.

### "I get `tsx: Permission denied` when running `npm run`"

Your `node_modules/` is missing or broken. Fix:

```bash
cd ~/claude-pmax-harness
rm -rf node_modules package-lock.json
npm install
```

### "`harness doctor` says MemPalace bridge ping FAILED"

The Python venv with MemPalace isn't installed. Fix:

```bash
cd ~/claude-pmax-harness
scripts/install-mempalace.sh
npm run -s harness -- doctor
```

### "The bot is `online` in pm2 but not replying on Telegram"

Three things to check:

1. **You're chatting with the right bot.** Confirm the username matches
   what BotFather gave you. The bot ignores messages from other users.
2. **Your chat ID is correct in `.env`.** The bot's owner-gating drops
   messages from any chat ID other than the one you configured. Open
   `.env`, double-check the `TELEGRAM_OWNER_CHAT_ID=` line.
3. **Telegram + Anthropic are both reachable.** `pm2 logs
   claude-pmax-harness` will show errors if either is unreachable.

### "I get `409 Conflict` errors in the logs"

Two processes are trying to poll Telegram for the same bot at the same
time. Common causes:

- You started the bot twice. Run `pm2 status` — if you see two entries,
  delete the duplicate: `pm2 delete <id>`.
- You're running the bot in another window (`npm run harness -- bot`)
  AND pm2 is also running it. Stop one.

### "I want to nuke everything and start over"

```bash
pm2 delete claude-pmax-harness
rm -rf ~/.claude-pmax-harness   # deletes MemPalace + state
cd ~/claude-pmax-harness
rm -rf personal/ .env           # deletes your config
# Now re-run from Step 5 (`harness setup`).
```

To remove the harness install entirely:

```bash
pm2 delete claude-pmax-harness
rm -rf ~/claude-pmax-harness ~/.claude-pmax-harness
```

(This doesn't touch your Telegram bot — to delete that, go back to
@BotFather and `/deletebot`.)

### "I'm getting `rate_limit_error` or `overloaded` messages"

You've hit your Pro Max usage cap. Wait the rolling window out (5 hours
typically). To stay under future:

- Disable cron jobs you don't actively use (`enabled: false` in the job
  frontmatter, then `pm2 restart claude-pmax-harness`).
- Disable the heartbeat in `personal/config.yaml`:
  ```yaml
  assistant:
    heartbeat:
      enabled: false
  ```

### "Something weird is happening and I don't know how to diagnose"

In order:

1. `pm2 logs claude-pmax-harness` — last 15 lines often have the answer
2. `npm run -s harness -- doctor` — checks the install
3. In chat, send `/errors` to the bot
4. Read the relevant section of `docs/architecture.md` (especially §17
   "operational patterns" for resilience-related issues)

---

## Glossary

- **CLI** — command-line interface. The black/dark window where you type
  commands. Sometimes called "terminal," "console," or "shell."
- **cron** — a way to schedule jobs to run at specific times. The harness
  uses a 5-field cron expression (e.g. `30 7 * * *` = 7:30 AM daily).
  See [`cron-recipes.md`](./cron-recipes.md).
- **daemon** — a program that runs in the background. The bot runs as a
  daemon when supervised by pm2.
- **dependency** — a library your project needs to work. The harness has
  about 70 dependencies (grammY, mustache, etc.) installed by
  `npm install`.
- **`.env`** — a text file holding secrets (tokens, passwords) the
  harness needs at runtime. Gitignored by default — never share it.
- **MemPalace** — the bot's long-term memory (verbatim conversations).
  Open source, runs locally on your machine.
- **pm2** — a "process manager." Keeps the bot running in the background,
  restarts it on crash, and gives you `pm2 logs` / `pm2 status`.
- **systemd** — a power-user alternative to pm2 (Linux-only). The
  harness ships a systemd unit example at
  `examples/systemd/claude-pmax-harness.service`.
- **WSL2** — Windows Subsystem for Linux. Lets Windows users run Linux
  programs (including this harness). Install with `wsl --install` from
  an admin PowerShell.

---

## Where to go next

- [`cron-recipes.md`](./cron-recipes.md) — write your own scheduled jobs.
- [`inspiration.md`](./inspiration.md) — example things to ask your bot.
- [`../PRIVACY.md`](../PRIVACY.md) — what data lives where + how to wipe it.
- [`architecture.md`](./architecture.md) — the full architecture
  spec if you want to understand how the bot works under the hood.
