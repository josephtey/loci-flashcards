# Loci

A spaced repetition memory system fed by an Obsidian vault.

Every sync reads what changed in the vault, writes prompts covering it, and puts them into an
FSRS deck. The design rationale — and the evidence behind each choice — is in
[`docs/prompt-principles.md`](docs/prompt-principles.md), distilled from Andy Matuschak's notes
on prompt writing.

![Loci — today's goals and a year of activity](docs/screenshots/home.png)

<table>
<tr>
<td width="50%"><img src="docs/screenshots/review.png" alt="A card, revealed, with the four grades and the interval each one buys"></td>
<td width="50%"><img src="docs/screenshots/sync.png" alt="The sync modal: folder filter, the diffs it found, and what it would cost"></td>
</tr>
<tr>
<td><img src="docs/screenshots/cards.png" alt="Every card grouped by source note, coloured by memory strength"></td>
<td><img src="docs/screenshots/methodology.png" alt="The methodology page, where every extraction prompt is editable"></td>
</tr>
</table>

<p align="center">
  <img src="docs/screenshots/m-home.png" width="240" alt="Home on a phone">
  <img src="docs/screenshots/m-review.png" width="240" alt="Reviewing on a phone">
  <img src="docs/screenshots/m-cards.png" width="240" alt="The deck on a phone">
</p>


---

## How it works

```
vault ──▶ diff ──▶ ① targets ──▶ ② write ──▶ ③ judge ──▶ dedup ──▶ deck ──▶ [ you grade or drop ]
          hashed   span+angle    3 drafts    keep 1      vs. deck   active   vetting is the review
```

**The diff engine** keeps its own snapshot — full note text plus a hash per semantic block —
rather than leaning on git. A changed note is found by content hash; the changed *parts* by block
hash. Blank-line-separated list runs merge back into one block, so a four-step mechanism stays one
unit rather than four; oversized outlines then split along their own indentation, so a note
written as one deep nested list doesn't collapse into a single block that reads as wholly changed
every time one bullet moves. Blocks keep their ancestor bullets as a breadcrumb path.

A block whose hash disappears isn't assumed deleted — its text has to be genuinely absent from the
note. Cards are pinned to the hash of the block they came from, so without that check, any change
to how the splitter draws boundaries would retire most of the deck at once.

The snapshot is committed **per note, after that note has been extracted from**. Committing it up
front means a run that's cancelled or crashes halfway leaves every note it never reached looking
already-read, and the next sync passes over them in silence.

**Flagging beats guessing.** Writing `***` beside a passage marks it as load-bearing: the sweep
covers it more thoroughly and the note's target budget grows to make room, so a flagged paragraph
earns several cards where its neighbours earn one. Choosing what deserves a prompt is the judgement
the model is worst at, and this is the cheapest channel for overriding it. The marker and how much
it is worth are both tunable from `/methodology`.

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

**20 new cards a day, 50 reviews.** A card needs roughly eight to ten reviews to reach multi-year
stability, so steady-state review load is about 8–10× the daily new-card rate, permanently — which
makes 20 an ambitious intake against a 50-review ceiling. The trade is deliberate: the deck is fed
by one person's writing, so clearing the queue after a sync matters more than holding the two
numbers in balance. The 50 is a cap rather than a quota — on the day you return to a backlog it
time-boxes the dig instead of asking for three hundred cards. Both live in `src/lib/goals.ts`; if
due counts climb week over week, lower the intake.

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

Everything works on a phone — the card is a large tap target that flips, every keyboard shortcut
has a button behind it, and `viewport-fit=cover` plus `dvh` units keep the grade buttons clear of
the home indicator. Add it to the home screen and it opens without browser chrome.

**Every prompt is editable at runtime** from `/methodology` — the files in `prompts/` are read from
disk per run, not baked into the build. So is the tuning in `prompts/config.json`.

### Two ways to answer

Every session has a toggle in its top-right corner.

**self** is the original flow: reveal the answer, decide for yourself how well it came back.

**type it** asks you to write the answer first, and a small Qwen model running locally through
Ollama scores it into the same four grades. It exists because it is impossible to think *"I knew
that"* at a blank screen and be wrong — self-grading measures confidence, and typing measures
recall.

The grade is a **proposal, not a verdict**. It appears alongside the real answer with the model's
reasoning and whatever it thought you missed, with its pick outlined on the grade buttons.
`↵` accepts it, `1`–`4` overrides it, and nothing is written until you do one or the other. Every
review records both numbers, so `grader_rating <> rating` is the running list of places the
auto-grader is wrong, with the answer that fooled it in the same row. Flip `graderAutoAccept` in
`/methodology` once the disagreements stop being interesting.

Cards with no reference answer — the open, catechism-style ones — always fall back to self-grading.
A grader with nothing to compare against is guessing, and its guesses would land in the very log
being used to judge it. `s` hands any other card back to you too.

The model runs **on your machine**: no per-card cost, no network, and nothing you type leaves the
laptop. See [Recall mode](#4-recall-mode) for setup.

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

### 4. Recall mode

Optional — the deck works without it, and the **type it** toggle simply stays greyed out with a
reason. To turn it on:

```sh
brew install --cask ollama-app    # the app bundle, NOT `brew install ollama`
open -a Ollama                    # click through the first-run screen once
ollama pull qwen3.5:4b            # 3.4GB
```

Use the **cask**, not the formula. The Homebrew formula ships a 60MB CPU-only binary — it works,
and it is roughly ten times slower, because it never touches Metal. `ollama ps` tells you which
one you have: it should say `100% GPU`, not `100% CPU`.

`qwen3.5:4b` is the default because it was measured, not guessed:

| model | agrees with a human | median |
|---|---|---|
| **qwen3.5:4b** | **17/18** | ~2.9s |
| qwen3.5:2b | 11/17 | ~1.3s |

2b is twice as fast and not safe — it scored a flatly wrong answer as *Good*, which is the one
failure mode that matters, since it schedules a misconception as if you knew it. Change the model
in `/methodology` (`graderModel`) if you want to try `qwen3.5:9b` on a bigger machine.

The rubric that does the grading is `prompts/grade-answer.md`, editable from `/methodology` like
every other prompt. It is prose, and prose has no tests, so measure what an edit did:

```sh
npm run bench:grade              # the default model
npm run bench:grade qwen3.5:9b   # or any other
```

The first draft of that rubric scored 15/17 *and gave every correct answer an Easy* — which would
have quietly stretched every interval in the deck. Nothing surfaced it except running this.

#### Hosted (Vercel)

There is no laptop inside a Vercel function, so `127.0.0.1:11434` is nothing and the toggle greys
out. Point it at Ollama's hosted service instead — three env vars, no other change:

```
OLLAMA_HOST=https://ollama.com
OLLAMA_API_KEY=<from https://ollama.com/settings/keys>
OLLAMA_MODEL=gpt-oss:120b
```

`OLLAMA_MODEL` is needed because `prompts/config.json` is committed and read-only when hosted, so
`graderModel` can't be changed there — and the local default doesn't exist on the cloud.

**This works on the free tier**, which was worth measuring rather than assuming:

| model | tier | agrees | median |
|---|---|---|---|
| **gpt-oss:120b** | **free** | **18/18** | **~0.7s** |
| qwen3.5:4b (local) | — | 17/18 | ~2.9s |
| nemotron-3-nano:30b | free | 13/18 | ~0.8s |
| qwen3.5:397b | Pro, $20/mo | untested — needs a subscription | |

Two gotchas the code already handles, both found by measuring:

- **ollama.com does not compile the `format` grammar.** A schema-constrained request comes back as
  prose (`**Score: 1** – the response does not…`), so `src/lib/grader.ts` states the JSON contract
  in words as well and parses tolerantly. Local Ollama enforces the schema; the cloud does not.
- **Free-tier calls can cold-start.** A typical grade is under a second, but one measured call took
  42 — so the request timeout is 25s local, 75s hosted.

Free-tier usage resets on rolling 5-hour and 7-day windows, so a very heavy session could hit a
limit; a grade that fails for any reason falls back to self-grading that one card rather than
losing it. `gpt-oss:120b` is not Qwen — Qwen on the cloud needs the $20/mo Pro tier. If you
subscribe, one command tells you whether it is worth it:

```sh
OLLAMA_HOST=https://ollama.com npm run bench:grade qwen3.5:397b
```

### 5. Hosting

The web app deploys anywhere. The two features that read the vault — **Sync with Obsidian** and
**Draft with AI** — need the markdown on the same machine, so a hosted copy greys them out and
says why rather than failing. Reviewing, browsing, editing and writing cards by hand all work
fine hosted, since they only need Postgres.

Recall mode works hosted too, but only if you point it somewhere — see
[Hosted (Vercel)](#hosted-vercel). Left alone it greys out like the vault features do.

Prompts are also read-only when hosted: the filesystem is, so `/methodology` shows them but can't
save. Edit them in the repo, or locally.

The hosted copy is open by default. If you'd rather keep the deck to yourself, set
`LOCI_PASSWORD` on the deployment: every page and API route then sits behind it — one password,
one cookie that lasts a year per device, a `Bearer` header for anything that isn't a browser.
On the phone: Safari → Share → **Add to Home Screen**. The manifest and icons are in place, so it
installs with its own icon and opens fullscreen.

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
src/scanner/                local CLI — vault, blocks, sync, prompts, extract, doctor, reset,
                            grade-bench (measures a rubric edit against known-good gradings)
src/lib/                    types, supabase client, FSRS wrapper, queries, goals, grader
src/app/api/                scan control, review grading, card CRUD, sync preview/result/log
src/components/             review session, sync modal, activity graph, day detail
```

`reviews` is append-only and is the actual asset. Everything else is derived from it. With the
full log the FSRS parameters can be re-fit to your own history after ~200 reviews, or the whole
deck replayed through a different scheduler; with only `next_due` you'd be locked to today's
weights forever. Recall mode widens that same row rather than adding a table of its own: the
typed answer and the grade the model wanted sit next to the grade that was actually scheduled.
