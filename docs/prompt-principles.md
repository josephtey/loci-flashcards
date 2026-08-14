# Prompt principles for Loci

Distilled from Andy Matuschak's working notes (`notes.andymatuschak.org/z2D1qPwddPktBjpNuwYFVva`
and ~25 notes in its graph) plus *How to write good prompts* (andymatuschak.org/prompts, 2020).

This file has two jobs:
1. It is the design spec for how Loci generates and reviews cards.
2. Its "Principles" section is injected **verbatim** into the extractor's system prompt.
   Andy found LLMs write materially better prompts when handed the principles explicitly,
   and better still when asked to justify each prompt against them (chain-of-thought).

---

## 0. The one thing to optimize

> "The critical thing to optimize in spaced repetition memory systems is emotional connection
> to the review session and its contents — and conversely, to ruthlessly minimize elements
> which provoke a sigh."

Everything below is downstream of this. A technically-correct card that makes Joseph sigh is a
net negative: it costs review time *and* erodes the habit. When a rule here conflicts with
"would this be a chore," the chore-avoidance wins.

Corollary that Loci is structurally well-suited to: *"Spaced repetition review sessions often
become boring and detached without a steady stream of new prompts."* A nightly extraction job is
precisely the fix for that failure mode. This is our main advantage over a static Anki deck.

---

## 1. Architecture: target selection and prompt writing are two different problems

The single most important architectural finding in Andy's LLM notes:

> "**Identifying what deserves prompts** represents a fundamentally harder challenge than
> **composing prompts about a specified detail**. The model lacks crucial context: your
> interests, existing knowledge, and goals for the material."

So Loci must **not** do `diff → "write flashcards"`. It runs a two-stage pipeline:

```
changed note
  └─ Stage 1: propose REINFORCEMENT TARGETS
       a target = { span in the note, angle hint, one-line rationale }
  └─ Stage 2: for each approved target, WRITE PROMPTS (n candidates)
  └─ Stage 3: filter/rank candidates down to 1–3
```

**The approval queue operates primarily at the target level, not the card level.** That is where
Joseph's taste actually lives, it is the judgement the model cannot make, and it is far faster to
triage ("yes, that's the interesting bit" / "no") than to read four finished cards.

### Over-generate and filter

> "Something much like the question I want is often produced by the model, if I'm willing to
> generate and evaluate enough samples… The discard count may be closer to 10 (with GPT-3; with
> GPT-4, it's lower)."

Rejected candidates are *"almost always well-formed questions… They just lack any sense of what's
interesting about a passage."* So: generate several candidates per target, run a filter pass
against the principles below, surface the survivors. Do not try to one-shot a perfect card.

### Angle hints are mandatory

> "There are often so many things one *could* reinforce about a phrase… The model doesn't know
> which you want." Hints are *"only consistently unnecessary when reinforcing simple statements
> of fact."*

Every target carries an explicit `angle` from the taxonomy in §3. In the absence of a human
highlighting-and-scribbling-"why" gesture, the model proposes the angle and Joseph corrects it in
the UI. Correcting an angle must be one tap.

### Give the model lots of context, not just the diff

> "Unless the selected material is an isolated declarative atom, the model will generally need
> more context… supplying several thousand surrounding tokens."

**This overrides the naive diff design.** The diff selects *targets*; it does not bound *context*.
Feed the extractor the **entire note** (Evergreen notes average ~1.4 KB — this is free) plus the
titles and first paragraphs of `[[wikilinked]]` notes. Diff answers "what's new to look at,"
never "what the model gets to see."

### Why this should work better than the generic case

Andy's caveat is that LLMs are worst at exactly the conceptual material Joseph writes. But he also
records the mitigating fact:

> "Models produce superior prompts from already-distilled personal notes compared to raw longer
> passages… One approach that might help is to also generate prompts from one's notes about a text."

Joseph's Evergreen folders *are* already-distilled personal notes. This is the best-case input for
the technique, not the average case.

---

## 2. Principles — injected verbatim into the extractor

### The five properties of a good prompt

| Property | Test |
|---|---|
| **Focused** | One atomic unit. Too much detail dulls concentration and yields incomplete retrievals. |
| **Precise** | Vague questions elicit vague answers. The question must state what shape of answer it wants. |
| **Consistent** | Produces the same answer every time — "lighting the same bulbs each time." |
| **Tractable** | You can almost always answer it correctly. Target ~90–95% success. |
| **Effortful** | The answer must actually be retrieved from memory, not inferable from the question. |

### Hard rules

- **No yes/no or this/that prompts.** They require almost no effort. Rephrase as open-ended.
- **Keep questions short.** Long, distinctive questions get pattern-matched — you recognise the
  question shape rather than retrieving the answer.
- **Nothing in the question may give away the answer.**
- **No orphans.** Do not write a prompt about a detail disconnected from everything else Joseph
  is thinking about. Orphans become chores and are poorly retained because nothing in daily life
  reinforces them. Prefer targets that connect to other notes in the vault.
- **Preserve hedging.** If the source note expresses uncertainty, the prompt must too. Never
  flatten a tentative position into an assertion. (Joseph's note on PLMs says outright *"I don't
  know if I am convinced that this implies memorization"* — a card asserting that PLMs memorize
  would teach him a belief he does not hold. This is the worst failure mode available to us.)
- **Never card a stub, a TODO, a question-to-self, or content that lives only in an image.**

### Expert response heuristic (Issa Rice)

> An expert in the topic should be able to answer the prompt *without* having read the specific
> source note.

Failing this means the prompt encodes source-specific framing and produces parochial understanding.

**Apply this as a filter to `Ever Green Learnings` (technical) only. Explicitly exempt
`Ever Green Notes`.** Those notes are Joseph's own claims; their whole value is parochial, and
Andy notes parochial encoding is *"often helpful, particularly as elaborative encoding or a way of
cultivating emotional interest."*

### Prefer Q&A over cloze

> "Cloze deletion prompts seem to produce less understanding than question-answer pairs… After
> several repetitions I'll remember the answer, but it often feels like I'm pattern matching
> rather than deeply integrating the idea."

Cloze carries extraneous hint-text, captures only one angle, is rarely atomic, and is prone to
ambiguity. So **Q&A is the default**, and for conceptual and explanatory material it is the only
option — a cloze over an argument tests whether you can fill a gap, not whether you understand it.

But the other half of Andy's note matters too: cloze is *"an extremely efficient way to produce
new prompts,"* and *"if the choice is between cloze prompts and nothing at all, the cloze prompts
are definitely better."* For the foundational tier that is the right trade. Cloze is therefore
legitimate in three places:

1. **Closed-list enumeration** — one element deleted per prompt, consistent ordering (below).
2. **Terminology and notation** (`term`) — expanding an abbreviation, or which symbol denotes
   what. There is no understanding to be had here; there is a string to know.
3. **Definitional statements** (`definition`, `fact`) where the deleted span *is* the whole
   answer and the surrounding sentence is genuinely load-bearing context rather than a hint.

Rule 3 is the one that goes wrong. If the remaining sentence would let you guess the deletion
without knowing it, that is a hint, and the card fails "effortful" — write the Q&A instead.

### Enumerations and lists

Joseph's technical notes are largely numbered lists (`Linear Probing` is four steps), so this
matters more here than in a typical vault. **Do not write "list all N steps" prompts** — those are
the set/enumeration anti-pattern: unfocused, intractable, and they fail inconsistently.

- **Closed list** (fixed membership, e.g. the 4 steps of a linear probe): cloze one element per
  prompt, with consistent ordering so the list's shape is internalised. Then add *transition*
  prompts — "after projecting the activation onto the probe direction, what do you do with the
  sign, and why?" — which are where the actual understanding lives.
- **Open list** (unbounded, e.g. "ways L1/L2 show up"): three complementary prompts —
  instance→tag, a pattern-observation across instances, and tag→instances ("name two…").

### Multiple angles, and write more than feels natural

> "Effective prompts reinforce an idea by accessing it from multiple angles."
> "Write more spaced repetition prompts than seems natural… prompts are cheap: 10–30 seconds
> across the entire first year of practice."

So: **2–4 prompts per approved target, each from a different angle** — not one. Coarser prompts do
not reduce the learning burden; they just make the material harder to review.

Counterweight: prompts have an *emotional* cost beyond time. For material Joseph already knows
cold, fewer prompts.

---

## 3. Angle taxonomy

Every target gets exactly one. Stage 2 writes to the angle.

**Conceptual** (the default for Evergreen material)
- `attributes` — what makes it fundamentally what it is; what's always/sometimes/never true
- `contrast` — what relates it to and distinguishes it from adjacent concepts
- `parts-wholes` — sub-types, super-categories, what it's a part of
- `causes-effects` — what it does, what makes it do that, when it's used
- `significance` — why it matters, what it implies, "so what?"
- `explanation` — *why* is this true (not *what* is true)

**Procedural** (for the mechanism-style technical notes)
- `transition` — when do you move from this step to the next
- `parameter` — the critical value, threshold, or condition
- `heuristic` — how do you recognise readiness / that it worked
- `rationale` — why this choice rather than the obvious alternative

**Salience / identity** (for `Ever Green Notes`)
- `salience` — keeps an idea top-of-mind and applicable rather than merely recalled
- `application` — apply this lens to something recent (deliberately vague context; see §4)
- `claim` — Joseph's own position, its argument, and its strongest counter

---

## 4. `Ever Green Notes` are a catechism, not a quiz

Andy takes this seriously, and it validates treating these 64 notes differently:

> "On their surface, catechisms are about memorizing doctrinal knowledge, but they also effect a
> change in identity through repeated exposure… it may also be possible to use spaced repetition
> systems to program one's identity more directly."

His example card has **nothing on the back**: *"At this instant, what unsolved question do I
instinctively find most fascinating about quantum computing?"*

Implications for Loci:
- `claim` and `application` cards may legitimately have an empty or gestural back. The card is a
  recurring *task*, not a test. (*"Spaced repetition prompt design is about designing tasks for
  your future self."*)
- Application prompts must keep context vague — *"apply the lens of utilitarianism to a recent
  decision,"* not to a named case. If Joseph wrote the specific version he has already thought it
  through, and it degenerates into a memory prompt.
- The `still_endorse` field survives contact with Andy: he explicitly frames evergreen-note
  maintenance as approximating spaced repetition, and spaced repetition as a way to lower the
  stakes of inbox-style grooming. A "my view has shifted" tap that flags the source note for
  revision is a legitimate primitive, not a gimmick.

---

## 5. Review mechanics

### Self-grading, 4 buttons. Not machine grading.

> "Self-graded systems outperform machine-graded systems in most respects" — more efficient,
> avoid false negatives, accommodate a wider variety of prompts.

**This reverses the earlier plan to add LLM answer-grading.** It would be slower, would produce
false negatives on correct-but-differently-worded answers, and would rule out exactly the
open-ended `claim` / `application` / `salience` cards that make this system worth building.
Machine grading buys better knowledge modelling; we don't need that. Drop it.

### Skip, with backoff — never drop

Andy proposes a skip button as a low-stakes alternative to deletion, to keep sessions emotionally
connected. But he also cites the evidence against letting users drop cards:

> Kornell & Bjork (2008): *"being allowed to drop flashcards had small but consistently negative
> effects on learning… 68% of the items were dropped after only one correct response."*
> Whitmer et al. (2020): trainees allowed to drop cards had substantially worse post-test memory.

So: **skip defers with exponential backoff; it never deletes.** After the 3rd skip, the card is
routed back into the approval queue as *"this keeps making you sigh — rewrite or retire?"* — which
is the refactoring loop, not a drop.

### Failure means the prompt is broken, not you

> "If you often forget an answer, you must refactor the question or risk future eye-rolls."

A card that lapses ≥3 times auto-flags for rewrite. Loci should offer to re-run Stage 2 on the
original target with a different angle. **A "this prompt is bad" button in the review UI is a
first-class feature**, and it routes to the same editor as the approval queue.

### Schedule expectations

- FSRS's default parameters are fit largely on language-learning decks. Joseph's deck is
  conceptual, and *"conceptual information may have much slower optimal spaced repetition
  schedules."* Expect longer intervals to be fine.
- But: *"even for conceptual material, forgotten prompts should probably be reviewed the next day."*
  Keep a short relearning step.
- Storing the full append-only review log is what lets us re-fit FSRS parameters on Joseph's own
  data once there are ~200 reviews. This is the concrete payoff of the log, and the reason not to
  store only `next_due`.

### Intake budget

Andy's arithmetic: 40 new prompts/day → ~200 reviews/day at the one-year mark → ~20 min/day at 6 s
per prompt. For a **10-minute daily budget the sustainable intake is ~20 new prompts/day**, falling
to ~16/day at a 10% error rate and ~13/day at 20%.

Joseph edits ~5 notes/day across the whole vault, and only the Evergreen folders are in scope, so
realistic volume is well under this. **Cap the nightly job at 5–10 approved cards**, with the
knowledge that the ceiling is ~20/day if he wants to push. The cap's purpose is to force ranking,
not to control cost.

Note the leverage: dropping the error rate from 20% → 5% buys a third more prompts in the same
review time. Prompt *quality* is throughput.

---

## 6. The unresolved tension: authorship

This is the strongest argument against the entire premise of Loci, and it should stay written down.

> "Studying another person's spaced repetition memory prompts is usually ineffective."
> "The act of constructing an Anki card is itself nearly always a form of elaborative encoding.
> It forces you to think through alternate forms of the question, to consider the best possible
> answers." (Nielsen)

An LLM is, in the relevant sense, another person. Auto-generation forfeits the elaborative-encoding
benefit of authoring.

Three things make Loci a weaker case of this problem than downloading a stranger's deck:

1. **"Learn before you memorize" is satisfied by construction.** The source is Joseph's own
   post-understanding distillations, not a textbook he hasn't read. Evergreen-only scope is what
   buys this — it would *not* hold for `Reading/Inbox` or `Daily Log`.
2. **The material is already his**, so the prompts encode his framing rather than a stranger's.
3. **Approval and editing restore part of the encoding.** Editing a proposed prompt is a real
   cognitive act.

Which yields a concrete UI mandate: **make editing the default gesture, not approve.** The
cheapest interaction should not be "accept the robot's card." Worth prototyping the stronger
version — the queue shows the *target* and invites Joseph to write the prompt himself, with the
model's candidates one keypress away as a fallback. That recovers most of the elaborative encoding
while still solving the blank-page problem that left this vault with zero cards for 18 months.

---

## 7. What this changed from the pre-research design

| Earlier plan | Revised |
|---|---|
| `cloze` as a first-class card type | Demoted to closed-list enumeration only; Q&A is the default |
| `mechanism` card = "walk through all 4 steps" | Anti-pattern. Decompose: one element per prompt + transition prompts |
| Feed only changed blocks to the model | Diff selects *targets*; feed the **whole note** + linked-note context |
| One-shot "generate cards from diff" | Two-stage: targets → prompts; over-generate and filter |
| ~1 card per idea | 2–4 per target, different angles ("more than seems natural") |
| Approval queue reviews finished cards | Queue reviews **targets** first — that's where taste lives |
| Add LLM answer-grading later as the edge over Anki | Dropped. Self-grading is better on efficiency, false negatives, and card variety |
| Reject → delete | Skip with exponential backoff; lapses route to rewrite; never drop |
| Cap of 5/night chosen arbitrarily | 5–10, against a derived ceiling of ~20/day for a 10-min session |

---

## Sources

- [Spaced repetition memory system](https://notes.andymatuschak.org/z2D1qPwddPktBjpNuwYFVva) (hub)
- [How to write good prompts](https://andymatuschak.org/prompts) (2020)
- [Important attributes of good spaced repetition memory prompts](https://notes.andymatuschak.org/z9xavmmNq7xvNqzpnJ3HFXx)
- [Using ML to generate good prompts from explanatory text](https://notes.andymatuschak.org/zBjh9jUahGSm7VpFtEjvKqT)
- [Choosing reinforcement targets and writing prompts are two separate problems](https://notes.andymatuschak.org/zPZqDQquq8TAxRVqCQTkxkq)
- [Framing prompt generation as a filtering problem](https://notes.andymatuschak.org/zH8aesAjdej6KjCrPA8cAMi)
- [LLMs lack prompt-writing patterns for complex conceptual material](https://notes.andymatuschak.org/zGkLPdiEs7Qohkesq7TNiBe)
- [The critical thing to optimize is emotional connection](https://notes.andymatuschak.org/zPiRwRHQxGfF9Zej765PB8M)
- [Cloze deletions produce less understanding than Q&A pairs](https://notes.andymatuschak.org/zPJt42JTcoAPTTTa2vdDonV)
- [Self-grading vs. machine-grading](https://notes.andymatuschak.org/zScaVuH9r2pwo24iD3f39bU)
- [Avoid orphan prompts](https://notes.andymatuschak.org/z3uFvLFRt8ognrjd6ADZMJc)
- [Spaced repetition systems as catechism](https://notes.andymatuschak.org/zPtcwHaKGoLEZRzSoScYXha)
- [Expert response heuristic, after Issa Rice](https://notes.andymatuschak.org/z2pzGHXwct867CYxcBwUABg)
- [What's the maximum intake rate?](https://notes.andymatuschak.org/zQQjjGJKWXbiA67R4jhzvz8)
- [A "skip" mechanism may help sessions remain emotionally connected](https://notes.andymatuschak.org/zCajfeVzLxpqtCzvF7jXVVy)
- [Learn before you memorize](https://notes.andymatuschak.org/z7nmQ12agpmDmFoonENsQQN)
- [How important is it to write your own prompts?](https://notes.andymatuschak.org/zV7ho8fLnyvPCGV3zpLFTHb)
