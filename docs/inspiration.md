# Inspiration — what to do with your bot

You've installed it. The bot waves hello. Now what?

This is a tour of what a personal AI assistant on your machine is
*actually* good for. Each entry includes a prompt you can paste, what
kind of response to expect, and how the conversation tends to evolve.

Try a few. The bot isn't claude.ai — it has long-term memory, it knows
who you are (via `personal/CLAUDE.md`), it can read your wiki and your
calendar (if Google's wired up), and it can run scheduled jobs. Those
four things change what makes sense to ask.

---

## How this bot is different from claude.ai

- **It remembers.** Tell it something today; ask about it next month.
  Memory lives at `~/.claude-pmax-harness/data/mempalace/`.
- **It knows who you are.** Every conversation starts with your
  `personal/CLAUDE.md` injected. Edit that file to teach it your
  preferences, values, projects.
- **It has tools.** Web search, web fetch, read your files, edit your
  files, run shell commands (if you opted into `allow_dangerous: true`).
- **It can run on a schedule.** Anything you can ask in chat, you can
  also schedule via a cron job — see [`cron-recipes.md`](./cron-recipes.md).
- **It's yours.** No conversation cap per session, no UI nudging, no
  product surface telling you what to do. It's a tool that does what
  you ask.

That said: it's still Claude. The bot can't see the internet in real
time (web search is on demand, not continuous). It can't take an
action on your behalf unless you ask. And it can be wrong — verify
high-stakes claims.

---

## Conversation starters for your first week

The best way to get value is to throw real things at it. Some openers:

### Day 1 — bootstrap the bot's knowledge of you

```
Here's what I want you to know about me. I work in <field>. My main
projects right now are <X> and <Y>. I have <kid|partner|cat> named
<name>. I care a lot about <thing>; I don't care much about <thing>.
My weekly rhythm is roughly <describe>. Save this to your wiki for
reference.
```

The bot will append the relevant pieces into `personal/wiki/identity.md`
and related pages. Next conversation, it'll know all of this without
you re-typing.

### Day 2 — give it a recurring chore

```
I want to write a short reflection every Sunday evening. Set up a cron
job that prompts me at 8 PM Sunday with three questions: what went
well this week, what didn't, what to try differently. Show me the
job file before you save it.
```

The bot will draft the cron job file, you confirm, it writes to
`personal/cron/sunday-reflection.md`, you `pm2 restart
claude-pmax-harness`, done.

### Day 3 — ask it to remember a hard thing

```
I'm trying to decide whether to <hard thing>. The arguments for are
<...>. The arguments against are <...>. Don't tell me what to do —
just file this in your wiki as an open question. We'll come back to
it.
```

Now it lives in `personal/wiki/open-questions.md`. The bot can surface
it during a Sunday review cron, or you can ask "what open questions
am I sitting on?" anytime.

---

## Categories of use

### 1. Research help — go deeper than a quick search

```
Look up the current state of <topic> as of this year. I want:
- A 4-bullet status summary
- 2 names of people doing the most credible work
- 1 question that nobody seems to be answering well
- 3 sources I should read myself
```

What to expect: the bot will run several web searches, synthesize, and
push back if the topic is too vague. Treat it as a starting point —
follow the source links and verify before depending on the synthesis.

Follow-up moves:
- "Now read [URL] and tell me if the summary above held up."
- "Save this synthesis to my wiki under `topics/<topic>.md`."

### 2. Writing help — drafts that sound like you

```
Help me write a <thing — email, post, etc> to <person/audience> about
<topic>. My constraints: <length, tone, must include, must not say>.
Draft three versions: one warm, one direct, one playful. I'll pick a
direction and we'll refine.
```

Tip: tell it the SPECIFIC thing not to do ("don't open with 'I hope
this finds you well'"). The bot's default voice is generic; constraints
sharpen it.

Follow-up moves:
- "Take version 2 and tighten the first paragraph — too many words."
- "Now match it to my writing style — read `personal/wiki/writing-style.md`
  and rewrite."

### 3. Life admin — the things you keep meaning to do

```
I keep meaning to <task>. I haven't because <reason>. Help me figure
out the smallest first move that actually unblocks me. Then add that
first move to my follow-ups.
```

What to expect: the bot will probe the "why I haven't" — that's usually
the actual blocker — and propose something small enough that you can
do it today. Then it appends a `- [ ]` line to
`personal/wiki/follow-ups.md`.

Follow-up moves:
- "Set a cron job for next Wednesday that asks if I did the thing."
- "What other follow-ups have been sitting in my wiki for more than
  two weeks?"

### 4. Learning — pick a topic and have a tutor

```
Teach me <topic>. I know <X> already. I'm trying to understand <Y>.
Walk me through the simplest explanation first, then add the
caveat / next layer. Pause after each layer and check whether I
followed before continuing.
```

What to expect: a Socratic-style teaching session. You can interrupt
anytime ("wait, why is that true?") and the bot won't lose its place.

Follow-up moves:
- "Write up what we just covered as a short note in `personal/wiki/topics/`."
- "Quiz me on this tomorrow as a cron job at 8 AM."

### 5. Brainstorming — pressure-test an idea

```
I have an idea: <describe it in a paragraph>. Don't just affirm it.
Steelman the opposition. List the three strongest reasons this idea
might be wrong, the three strongest reasons it might be right, and
what experiment would resolve the uncertainty cheapest.
```

What to expect: actual pushback, not flattery. The bot will name
specific failure modes. If you only want validation, ask for it
explicitly — but don't rely on this mode for high-stakes decisions.

Follow-up moves:
- "OK, design the experiment. Smallest version that gives real signal."
- "File this as an open question in my wiki."

### 6. Decision support — without the bot deciding for you

```
I'm trying to decide between <A> and <B>. Here's what I know about
each: <...>. My constraints are <time, money, energy>. My priors
are <I lean toward X because Y>. Don't pick for me — help me see
what I'm not seeing. What questions would change my answer?
```

What to expect: the bot will identify the questions you should be
asking that you aren't. Often more valuable than a direct
recommendation.

Follow-up moves:
- "I answered those questions: <...>. Now what jumps out?"
- "Save the framing of this decision as a wiki page; I want to come
  back to it in a month."

### 7. Code projects — the bot can actually run code

(Only works if you set `tools.allow_dangerous: true` in your config,
which enables Bash + Write + Edit.)

```
In <directory>, I have a project that does <X>. The current problem
is <Y>. Read the codebase, find the cause, and propose a fix. Don't
apply the fix yet — show me the diff.
```

What to expect: the bot uses Read + Grep + Glob to navigate the
codebase, then proposes changes. You confirm, it applies, it runs
tests if relevant.

Follow-up moves:
- "Apply the fix. Run tests. Tell me what happened."
- "Now write a short note in `personal/wiki/topics/<project>.md` so
  next time we open this codebase you remember the context."

### 8. Memory + recall — the bot's superpower

```
Remember the conversation we had a few weeks ago about <topic>?
What did we decide?
```

What to expect: the bot uses MemPalace's semantic search to find the
relevant past exchange and quote it back. Works whether you remember
the exact wording or just the topic.

```
What questions have I been asking lately that suggest I'm worried
about <thing>?
```

Pattern recognition across conversations. Real value when you trust
the bot enough to actually think out loud with it.

### 9. Creative — let the bot help you make something

```
Help me write a short story for <my kid / partner / friend>. Make it
about <character> who has to <decision/conflict>. I want it to land on
<theme>. Don't be didactic — the moral should be inferable, not
stated. Aim for 800 words.
```

What to expect: actual drafts (sometimes mediocre, sometimes
surprising). Iterate. Tell it specifically what's wrong ("the dialogue
is too clean — make people interrupt each other") and re-roll.

Follow-up moves:
- "Use this as a recurring cron job: every Friday, write a short story
  on a theme I name in chat earlier that week."

### 10. Health + body — daily reflection

```
I've been feeling <off / wired / flat / etc> for the last few days.
Help me think through what might be going on. Walk me through:
- Sleep last few nights (you'll have to ask)
- Diet / hydration / movement
- Stressors at work / home
- Emotional weather
Don't diagnose. Help me notice patterns.
```

What to expect: the bot won't play doctor. It will help you make sense
of multi-factor patterns. For actual health concerns, see a real human.

---

## Tips for better answers

1. **Give it constraints.** "Write a thing" gives you average output.
   "Write a 200-word email to my boss explaining why I want to move
   from the X team to the Y team, in a tone that's confident but not
   apologetic, avoiding business-speak" gives you something you can
   actually use.

2. **Tell it what NOT to do.** "Don't be flowery." "Don't say 'great
   question.'" "Don't list pros and cons — pick a side." Negative
   constraints are often more useful than positive ones.

3. **Ask for the first draft, not the final.** "Draft something I can
   react to. I'll tell you what to change." Lower the stakes.

4. **Use the wiki.** When you tell the bot something durable about
   yourself, ask it to file the fact in your wiki. Next session it
   uses what's in the wiki without you re-typing.

5. **Be willing to argue.** The bot defaults to deference. If you say
   "this seems wrong" it will often flip to agree. Push back on the
   first response: "what's the strongest case AGAINST what you just
   said?" That breaks the deference reflex.

6. **Use voice for thinking, text for output.** Voice notes (if you
   installed the optional transcribe venv) let you ramble through an
   idea without typing. The bot transcribes and routes through the
   same pipeline as text. Great for brainstorming.

7. **Treat memory as a privilege you can revoke.** The bot saves what
   you tell it. If something shouldn't have been saved, ask it to
   purge: `harness memory purge --all` is the nuclear option;
   `--query` and `--range` are more surgical (currently pending
   MemPalace upstream — see PRIVACY.md).

---

## What NOT to ask

The bot is good at lots of things. It's bad at:

- **Real-time data.** It can web search, but a search is a snapshot.
  Don't trust it for live stock prices, breaking news, or anything
  that changes minute to minute.
- **Things requiring physical action.** It can tell you how to fix
  your car. It can't fix your car.
- **Things you'd only trust a doctor / lawyer / therapist with.**
  Genuinely high-stakes professional advice. The bot is fine for
  framing or background research, but the actual decision needs a
  real human professional.
- **Things you don't want stored.** Anything you tell it goes into
  MemPalace by default. If you don't want it remembered, prefix the
  message with: "Don't save this to memory — just respond." (The bot
  won't honor this perfectly today since MemPalace storage is
  unconditional in v1; for now, use `harness memory purge --range`
  after the fact, or use claude.ai directly for sensitive one-offs.)

---

## Inspiration from other people

A handful of patterns real people have built into their personal bots:

- **"Friday voice memo"** — every Friday at 5 PM, a cron prompt asks
  the user to record a 2-minute voice note reflecting on the week.
  The bot transcribes + saves to wiki. Sunday's reflection job reads
  the week's voice notes.
- **"Decision diary"** — every time the user makes a non-trivial
  decision, they tell the bot. The bot files a dated note in
  `personal/wiki/decisions/`. Monthly cron reviews recent decisions
  and asks which ones the user already regrets.
- **"Travel concierge"** — before a trip, the user tells the bot the
  destination + dates. A cron job 24h before departure pulls weather,
  checks for events in the city, suggests one local restaurant. After
  the trip, the bot prompts the user to capture one specific thing
  they want to remember.
- **"Reading queue trim"** — the user adds links to a wiki page
  whenever they see something interesting. Weekly cron job summarizes
  the queue and suggests dropping anything that's been sitting more
  than 4 weeks (most things weren't actually that interesting).
- **"Tiny coach"** — the user has a goal like "write more." A daily
  cron job at 6 PM asks "did you write today?" with three follow-up
  prompts depending on answer. Streak tracking lives in the wiki.

The pattern: **the bot is best at attention management**. Most of these
recipes are variants of "make sure I notice X without being annoying
about it."

---

## Where to go next

- [`quickstart.md`](./quickstart.md) — install + first hour.
- [`cron-recipes.md`](./cron-recipes.md) — full cron-authoring guide
  with 12 example jobs you can copy.
- [`../PRIVACY.md`](../PRIVACY.md) — what's stored where + how to wipe.
- [`architecture.md`](./architecture.md) — under-the-hood spec for
  developers + power users.
