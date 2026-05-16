# Wiki Schema

This wiki is the synthesized, hand-curated kernel of context about you,
your projects, your decisions. It is complementary to MemPalace's verbatim
recall — different layer, different purpose.

| MemPalace | This wiki |
|---|---|
| Verbatim conversations | Synthesized current beliefs, decisions, projects |
| Things found by exact phrase | Things found by meaning |
| Routine task exchanges | Identity, principles, project state, decisions |
| The transcript of a conversation | The conclusion drawn from a conversation |

Pattern adapted from Andrej Karpathy's [llm-wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

## Structure

- `index.md` — catalog of pages, always loaded on new sessions
- `identity.md` — durable identity context, always loaded
- `principles.md` — working principles, always loaded
- `follow-ups.md` — `- [ ]` checkbox items the assistant should nudge about
- `open-questions.md` — active threads; closes go into `decisions/`
- `decisions/` — dated decision pages (`YYYY-MM-DD-short-title.md`)
- `projects/` — per-project context pages (referenced from index)
- `topics/` — durable topic pages (referenced from index)
- `log.md` — chronological append log of wiki operations (the assistant
  appends an entry every time it edits the wiki)

## Maintenance

The assistant is responsible for keeping this wiki current. Specifically:

1. When the user shares something durable (a decision, a preference, a
   project update), update the relevant page OR create a new one.
2. When creating a new page, add a line to `index.md`.
3. After editing the wiki, append a short entry to `log.md`:
   `- YYYY-MM-DD HH:MM | <page> | <one-line summary of the change>`
4. When a follow-up resolves, change `- [ ]` to `- [x]` in `follow-ups.md`.
5. When an open question gets answered, move it from `open-questions.md`
   to a dated decision file in `decisions/`.

The harness's nightly synthesis cron will help with maintenance once it's
wired up; until then, this is on the assistant + you.
