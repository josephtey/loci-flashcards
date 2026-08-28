import {
  createEmptyCard,
  forgetting_curve,
  fsrs,
  generatorParameters,
  State,
  type Card,
  type Grade,
} from 'ts-fsrs';
import type { CardStateRow, RatingValue } from './types';

/**
 * FSRS scheduling, wrapped so the rest of the app deals in plain row shapes.
 *
 * Two things worth knowing:
 *
 *  1. The parameters below are FSRS's stock weights, fit largely on language-learning decks.
 *     This deck is conceptual, and conceptual material appears to forget more slowly — so
 *     expect longer intervals to be fine. Once there are ~200 reviews in the log we can re-fit
 *     `w` against Joseph's own history. That re-fit is the whole reason `reviews` is append-only
 *     and stores `state_before`: with only `next_due` we'd be locked into these weights forever.
 *
 *  2. Relearning steps are kept short deliberately. Even for conceptual material, a forgotten
 *     prompt should come back the next day rather than in a week.
 */

const SCHEDULER_VERSION = 'ts-fsrs@5';

export const params = generatorParameters({
  request_retention: 0.9,
  enable_fuzz: true,
  enable_short_term: true,
  learning_steps: ['1m', '10m'],
  relearning_steps: ['10m'],
});

const scheduler = fsrs(params);

export { SCHEDULER_VERSION, State };

// ─────────────────────────────────────────────────────────────────────────────
// Row ⇄ ts-fsrs Card
// ─────────────────────────────────────────────────────────────────────────────

export function rowToCard(row: Partial<CardStateRow> | null | undefined): Card {
  if (!row || row.stability == null || row.difficulty == null) {
    return createEmptyCard(new Date());
  }
  return {
    due: new Date(row.due!),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsed_days ?? 0,
    scheduled_days: row.scheduled_days ?? 0,
    learning_steps: row.learning_steps ?? 0,
    reps: row.reps ?? 0,
    lapses: row.lapses ?? 0,
    state: (row.state ?? State.New) as State,
    last_review: row.last_review ? new Date(row.last_review) : undefined,
  };
}

export function cardToRow(cardId: string, card: Card): Omit<CardStateRow, 'skip_count' | 'skipped_until'> {
  return {
    card_id: cardId,
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state as 0 | 1 | 2 | 3,
    last_review: card.last_review ? card.last_review.toISOString() : null,
  };
}

export function newCardState(cardId: string): Omit<CardStateRow, 'skip_count' | 'skipped_until'> {
  return cardToRow(cardId, createEmptyCard(new Date()));
}

/**
 * The odds you'd still recall this card `daysAhead` from now, 0-1, if it is not reviewed before
 * then. Pass 0 for right now.
 *
 * FSRS's whole model is this curve: memory decays as a function of time since the last review
 * against the stability that review earned. It is the only honest way to ask "how is the deck
 * doing" — the counts you can see (how many are due, how many days late) describe a queue, not a
 * memory. A card with a 44-day interval that is five days late is at 97%; a card with a one-day
 * interval that is five days late is at 65%. Both read as "5 days overdue".
 *
 * `forgetting_curve` rather than the scheduler's own `get_retrievability` because that one
 * rounds elapsed time to whole days, which is right for scheduling and wrong for a chart — a
 * curve drawn from it comes out as a staircase, and its first point disagrees with the reading
 * beside it by a fraction of a percent.
 *
 * Returns null for a card that has never earned a stability, since there is no curve to sit on.
 */
export function retrievability(
  row: Partial<CardStateRow>,
  daysAhead = 0,
  now = new Date(),
): number | null {
  if (row.stability == null || !row.last_review) return null;
  const elapsed = (now.getTime() - new Date(row.last_review).getTime()) / 86_400_000;
  return forgetting_curve(params.w, Math.max(0, elapsed + daysAhead), row.stability);
}

// ─────────────────────────────────────────────────────────────────────────────
// Grading
// ─────────────────────────────────────────────────────────────────────────────

export interface GradeResult {
  next: Omit<CardStateRow, 'skip_count' | 'skipped_until'>;
  stateBefore: Card;
  stateAfter: Card;
}

export function grade(cardId: string, current: Partial<CardStateRow> | null, rating: RatingValue, now = new Date()): GradeResult {
  const before = rowToCard(current);
  const { card } = scheduler.next(before, now, rating as Grade);
  return { next: cardToRow(cardId, card), stateBefore: before, stateAfter: card };
}

/** Preview all four outcomes — used to show interval hints on the review buttons. */
export function preview(current: Partial<CardStateRow> | null, now = new Date()) {
  const before = rowToCard(current);
  const log = scheduler.repeat(before, now);
  return {
    1: log[1].card.due,
    2: log[2].card.due,
    3: log[3].card.due,
    4: log[4].card.due,
  } as Record<RatingValue, Date>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Skip — exponential backoff, never a delete
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Skip defers rather than drops. Kornell & Bjork (2008) found that letting people drop cards had
 * "small but consistently negative effects on learning" — 68% of items were dropped after a
 * single correct response. Whitmer et al. (2020) replicated it. So a skip buys 1d, 3d, 9d, … and
 * the card always comes back; after SKIP_LIMIT skips it routes to the rewrite queue instead of
 * quietly disappearing.
 */
export const SKIP_LIMIT = 3;

export function skipUntil(skipCount: number, now = new Date()): Date {
  const days = Math.pow(3, Math.min(skipCount, 5));
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/** A card that keeps lapsing is a broken prompt, not a broken memory. */
export const LAPSE_LIMIT = 3;

export function formatInterval(from: Date, to: Date): string {
  const mins = Math.round((to.getTime() - from.getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 1)}m`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d`;
  const months = days / 30.4;
  if (months < 12) return `${months.toFixed(months < 3 ? 1 : 0)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}
