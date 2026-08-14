const DELETION = /\{\{c(\d+)::(.+?)(?:::(.+?))?\}\}/g;

/**
 * Render Anki-style cloze text for either side of a card.
 *
 * `{{c1::answer}}` or `{{c1::answer::hint}}`. Hidden, the deletion becomes `[⋯]`, or `[hint]`
 * when one is given — a hint narrows the shape of the expected answer without giving it away,
 * which is the difference between a tractable card and an ambiguous one.
 */
export function renderCloze(text: string, reveal: boolean): string {
  return text.replace(DELETION, (_match, _n, answer: string, hint?: string) =>
    reveal ? answer : hint ? `[${hint}]` : '[⋯]',
  );
}

export function hasCloze(text: string | null | undefined): boolean {
  if (!text) return false;
  DELETION.lastIndex = 0;
  return DELETION.test(text);
}

/** The deleted spans, for showing what the card is actually asking you to produce. */
export function clozeAnswers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DELETION)) out.push(m[2]);
  return out;
}
