# Loci

A spaced repetition memory system fed by an Obsidian vault.

Every sync reads what changed in the vault, writes prompts covering it, and puts them into an
FSRS deck. The design rationale — and the evidence behind each choice — is in
[`docs/prompt-principles.md`](docs/prompt-principles.md), distilled from Andy Matuschak's notes
on prompt writing.

---

## How it works

```
vault ──▶ diff ──▶ ① targets ──▶ ② write ──▶ ③ judge ──▶ dedup ──▶ deck ──▶ [ you grade or drop ]
          hashed   span+angle    3 drafts    keep 1      vs. deck   active   vetting is the review
```

**The diff engine** keeps its own snapshot — full note text plus a hash per semantic block —
rather than leaning on git. A changed note is found by content hash; the changed *parts* by block
hash. Blank-line-separated list runs merge back into one block, so a four-step mechanism stays one
unit rather than four.

The snapshot is committed **per note, after that note has been extracted from**. Committing it up
front means a run that's cancelled or crashes halfway leaves every note it never reached looking
already-read, and the next sync passes over them in silence.

**Stage 1 proposes targets, not cards.** A target is a span plus an *angle* — which of thirteen
lenses on that span is worth reinforcing. Choosing what deserves a prompt is much harder than
writing a prompt about a chosen detail, so the two are separated. The count is proportional to how
much changed (~1 target per 110 words), and the diff selects targets without bounding context:
the extractor always sees the whole note plus linked notes.

**Stage 2 writes, stage 3 judges.** Three candidates per target, scored against the five
properties of a good prompt, one kept. A cheaper model then checks each survivor against what's
already in the deck — trigram Jaccard for the certain cases, a model call only for the grey band.

**Cards go straight into the deck.** There's no approval queue. Vetting happens on a card's first
encounter under *Learn*, because grading a card and judging it are the same act of reading — doing
it twice is the wasteful version. <kbd>d</kbd> drops a card at any point in its life, and the
reason is written to `extraction_feedback` to sharpen later runs.

**Review is self-graded, four buttons.** Self-grading beats machine grading on efficiency, false
negatives, and the variety of prompts it permits. Three lapses routes a card to rewrite, because a
prompt you keep forgetting is a broken prompt, not a broken memory.

### Daily goals

The home page leads with today, not the deck total — a total only goes up when you write more, so
it reads as debt however much work you do.

**5 new cards a day, 40 reviews.** A card needs roughly eight to ten reviews to reach multi-year
stability, so steady-state review load is about 8–10× the daily new-card rate, permanently. Five
new a day settles at forty-odd reviews and ten to fifteen minutes; ten a day settles at eighty to
a hundred, which is where people quit. The 40 is also a cap: on the day you return to a backlog it
time-boxes the dig instead of asking for three hundred cards.

The streak counts **days that ended with nothing owed**, not days with any activity. It's
reconstructed from history — each review carries the card's prior due date, so every stretch where
a card sat due-and-unreviewed is derivable. New cards don't count towards it: they're elastic, and
a day spent not learning something new costs nothing you already had.

---

## The app

| | |
|---|---|
| `/` | today's goals, streak, a year of activity, sync |
| `/new` | learn cards never seen — grade, edit, or drop |
| `/review` | what's due |
| `/cards` | every card grouped by source note, with memory tier |
| `/add` | ask for specific cards in one forward pass |
| `/methodology` | how extraction works — and every prompt, editable |

**Sync with Obsidian** opens a three-step modal: the diffs it found (accordion, scoped by folder
under `Ever Green Learnings`), then generation with a live clock and a cancel button, then a sweep
through what it wrote. A History tab keeps every past run with the diff text it read, so a batch of
weak cards can be traced back to the edit that produced it.

**Every prompt is editable at runtime** from `/methodology` — the files in `prompts/` are read from
disk per run, not baked into the build. So is the tuning in `prompts/config.json`.

---

## Setup

### 1. Environment

`.env.local` (see `.env.example`):

```sh
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
ANTHROPIC_API_KEY=sk-ant-...
VAULT_PATH=/Users/…/iCloud~md~obsidian/Documents/Life
VAULT_FOLDERS=Ever Green Learnings,Ever Green Notes
```

### 2. Database

Run the migrations in `supabase/migrations/` in order, in the Supabase SQL editor. Or with the CLI:

```sh
supabase link --project-ref <ref>
supabase db push
```

Every table has RLS enabled with no policies — deny-all. All access goes through this app's route
handlers using the secret key; the browser never talks to Postgres directly. That's what lets a
mobile client hook into the same deck later without the schema changing.

### 3. Run

```sh
npm run doctor     # env, vault, schema, model — check all four at once
npm run scan:dry   # report what changed; no model calls, no writes
npm run scan       # full pipeline
npm run dev        # http://localhost:3000
```

`npm run scan` takes flags: `--only <folder,folder>` to scope by path fragment, `--paths <a.md,b.md>`
with `--request "<what to extract>"` for a targeted run, `--force` to re-extract regardless of the
snapshot (what you want after editing the prompts, when the vault hasn't changed but the output
would), and `--cron`.

The scanner reads the vault off the local filesystem, so it runs on your machine, not on Vercel.
The web app deploys anywhere; only `npm run scan` is local — which is also why the sync button
only works in `next dev`.

---

## Nightly

Once the output has earned trust, `npm run scan` on a schedule. On macOS, launchd fires a missed
`StartCalendarInterval` job at next wake, so a closed laptop only delays the scan rather than
skipping it.

```xml
<!-- ~/Library/LaunchAgents/com.loci.scan.plist -->
<key>ProgramArguments</key>
<array>
  <string>/bin/bash</string><string>-lc</string>
  <string>cd /Users/josephtey/Projects/loci && npm run scan -- --cron</string>
</array>
<key>StartCalendarInterval</key>
<dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
```

---

## Cost and tuning

`claude-sonnet-5` for stages 1–3, `claude-haiku-4-5` for deduplication. A full sweep of 92 notes
came to 137 cards for about $5 — most of the prompt is identical across calls, so cache hits run
near 40%.

The knobs live in `prompts/config.json` and are editable from `/methodology`: words per target,
candidates per target, the keep threshold, batch size, the two duplicate-similarity bands, and
per-stage reasoning effort. The ceiling that matters isn't cost, it's review time — see *Daily
goals* above. Dropping the error rate from 20% to 5% buys a third more prompts in the same review
time, which is why stage 3 exists.

---

## Layout

```
docs/prompt-principles.md   design spec; §2–4 injected verbatim into the extractor
prompts/                    every extraction prompt, editable at runtime
supabase/migrations/        schema
src/scanner/                local CLI — vault, blocks, sync, prompts, extract, doctor, reset
src/lib/                    types, supabase client, FSRS wrapper, queries, goals
src/app/api/                scan control, review grading, card CRUD, sync preview/result/log
src/components/             review session, sync modal, activity graph, day detail
```

`reviews` is append-only and is the actual asset. Everything else is derived from it. With the
full log the FSRS parameters can be re-fit to your own history after ~200 reviews, or the whole
deck replayed through a different scheduler; with only `next_due` you'd be locked to today's
weights forever.
