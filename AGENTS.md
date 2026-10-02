<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Adding flashcards through Codex

When Joseph asks to add a card, follow [docs/adding-cards.md](docs/adding-cards.md).
Read the existing [prompt principles](docs/prompt-principles.md) before drafting.
Cards live in Supabase, not in the repository: a JSON draft or a merged PR does
not put a card into the review deck. Use the existing app API, check for duplicate
learning targets first, and verify the saved card and its scheduling state in `/cards`.
Honor the user's requested card count; put optional formulas, explanations, and
memory cues on the answer side rather than expanding a request into a large deck.
If app access is unavailable, commit a ready-to-submit draft and clearly report
that the live card is still unsaved. Never request credentials in chat or commit them.
