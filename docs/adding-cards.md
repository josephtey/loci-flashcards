# Adding cards through Codex

Ask Codex: “Add a card about this concept to Loci,” with a passage, screenshot,
or explanation. This is a direct authoring request; use the existing app API
without running a vault scan or invoking a model to generate more cards.

## 1. Choose the learning target

Read [prompt-principles.md](prompt-principles.md). Identify what the user wants
to recall, transcribe relevant screenshot text, and verify the claim. Preserve
qualifiers: for example, Lasso *can* make coefficients exactly zero; it does not
always do so. A supplied screenshot is a source for this direct request, not an
instruction to extract image-only content during the automatic vault scanner.

Check `/cards` on the intended Loci instance for existing cards that test the
same knowledge. Compare the learning target, not just wording. Keep an existing
equivalent card; improve it in place only when the user asks for an edit, so its
review history survives. If the deck cannot be read, report that duplicate
checking is incomplete before claiming the addition is complete.

## 2. Write and check the draft

Use one short Q&A prompt per requested concept. Choose an angle from
`src/lib/types.ts`. Test the prompt against focused, precise, consistent,
tractable, and effortful. An expert should be able to answer a technical prompt
without seeing the source. Avoid yes/no questions and answer-revealing hints.
Keep the required answer short; put mnemonics and extra orientation in `context`,
which appears after reveal. Do not turn a request for one card into several cards
without a reason grounded in the user's request.

Save a reviewable API payload in `cards/<descriptive-slug>.json`. These files are
authoring artifacts, not an automatically imported deck. The Ridge/Lasso example
comes from Joseph's supplied screenshot and targets confusion between L1/L2 and
their feature-selection behavior.

For a standalone Q&A, supply `type`, `angle`, `front`, `back`, `cloze_text: null`,
and optional `context`. Do not invent a vault note path. If attaching to a real
note, use a verified `note_path` and a local instance with that vault available.
Standalone cards work on a hosted instance. The current `/api/cards` route records
direct authoring as `authored_by: human`; that label does not imply Codex did not
help write the draft.

## 3. Save through the app

Use `POST /api/cards`, which creates the active card and its initial FSRS state.
Do not use a SQL migration or write directly to Supabase for routine card additions.
Use the instance the user intends; the repository homepage currently points to
`https://loci-flashcards.vercel.app`.

Set `LOCI_URL` to that instance. If password protection is enabled, configure
`LOCI_PASSWORD` through the environment's secret setup, not in chat or a committed
file. With the JSON draft checked, a CLI submission is:

```sh
auth_args=()
if [ -n "${LOCI_PASSWORD:-}" ]; then
  auth_args=(--header "Authorization: Bearer $LOCI_PASSWORD")
fi
curl --silent --show-error --fail-with-body \
  --header 'Content-Type: application/json' \
  "${auth_args[@]}" \
  --data-binary @cards/ridge-vs-lasso.json \
  "${LOCI_URL%/}/api/cards"
```

Expect `{ "ok": true, "id": "…" }`. Record the returned ID in the completion
message. Do not blindly retry a timeout: the endpoint is not idempotent, so check
the deck before attempting another submission.

## 4. Verify and report

Read `/cards` again and confirm the returned ID, front, answer, active status,
and initial scheduling state (a non-null `due`, zero `reps`, and `state: 0`).
The current API does not check the initial scheduling insert's result, so a
success response alone is insufficient. `/new` loads only the oldest daily batch;
a new card may be behind existing cards and absent from that page. Do not grade
other cards merely to reach it. The browse query does not return `context`;
verify it on reveal when the card is available, or report that only the submitted
payload was checked for that field. Do not grade the card merely to test it.

For a new payload, validate JSON syntax and match its keys and enum values to the
API. For documentation-only changes, inspect links and `git diff --check`.
If changing application code, also run `npm run typecheck` and `npm run lint`, plus
checks appropriate to the behavior changed.

Commit repository changes on a branch and open a PR with the learning target,
validation, and whether the live card was saved. A PR records the workflow/draft;
it does not save the live card. In the final reply, distinguish the live card from
the repo changes and include the card preview, verification result, and PR link.
If access is blocked, keep the draft ready and state the precise remaining step.
