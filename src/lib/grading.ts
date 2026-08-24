import { clozeAnswers, hasCloze, renderCloze } from './cloze';
import type { CardRow } from './types';

/**
 * What a card asks, and what counts as having answered it.
 *
 * This is the same derivation the review screen uses to decide what to show on each face, and
 * it lives here so the grader cannot drift from it. If the model were handed `front`/`back` for
 * a cloze card it would be marking the answer against text the reviewer was never shown.
 *
 * Client-safe on purpose — the review screen imports it to decide whether to offer the typing
 * box at all, and importing the server-only grader for that would drag `node:fs` into the
 * browser bundle.
 */
export interface Asked {
  question: string;
  /** Null when the card has no reference answer to grade against. */
  expected: string | null;
}

type GradableCard = Pick<CardRow, 'type' | 'front' | 'back' | 'cloze_text'>;

export function askedOf(card: GradableCard): Asked {
  if (card.type === 'cloze' && hasCloze(card.cloze_text)) {
    return {
      question: renderCloze(card.cloze_text!, false),
      // The deletions are the answer. Grading a cloze against the whole revealed sentence would
      // mark you down for not retyping the words that were never blanked out.
      expected: clozeAnswers(card.cloze_text!).join('; ') || null,
    };
  }
  return { question: card.front, expected: card.back?.trim() || null };
}

/**
 * Can this card be auto-graded?
 *
 * Open/catechism cards deliberately have no `back` — their value is the recurring question, and
 * there is no answer they are trying to elicit. A grader with no reference is guessing, and its
 * guesses would land in the same log we are using to measure whether the grader can be trusted.
 * These fall back to self-grading rather than being scored on vibes.
 */
export function gradable(card: GradableCard): boolean {
  return askedOf(card).expected !== null;
}

/**
 * Whether there is a grader to talk to, resolved on the server and handed to the review screen.
 *
 * Declared here rather than in `grader.ts` because the review screen is a client component and
 * needs the type: naming that module from the client, even in a type-only import, is a footgun
 * one careless edit away from pulling `server-only` into the browser bundle.
 */
export interface GraderStatus {
  available: boolean;
  reason: string | null;
  model: string;
}
