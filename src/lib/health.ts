/**
 * How the deck is actually doing, in five states.
 *
 * The home page already shows what is due and how deep the pile is. Neither answers the question
 * you actually want answered, which is whether any of this is going wrong. A queue is not a
 * memory: this deck currently carries seventy-odd overdue cards, the oldest twelve days late, and
 * its mean recall is 90% — exactly the retention it targets. A status built on overdue counts
 * would have shouted at a deck that is fine.
 *
 * So the primary signal is retrievability: how many memories have measurably decayed. The size of
 * the queue is the second signal, because a backlog you cannot clear in a sitting or two becomes
 * decay soon enough even when nothing has decayed yet. The two are reported separately, since
 * "you have forgotten things" and "you have a lot to get through" want different responses.
 *
 * Pure and client-safe. The counting happens in `recall()`; this only decides what it means.
 */

/**
 * Below this, a memory is measurably going.
 *
 * The deck targets 90% recall at the due date (`request_retention`), so 90% is not a warning
 * line — it is where a card is *supposed* to be when it comes up, and more than half the deck
 * sits under it on any normal day. 80% is roughly one interval past due: late enough to mean
 * something, early enough that the card comes back with one good answer.
 */
export const SLIPPED_AT = 0.8;

/** Below this a card is effectively new again, and re-learning it costs what learning it did. */
export const LOST_AT = 0.6;

const pct = (n: number) => `${Math.round(n * 100)}%`;

export type HealthKey = 'losing' | 'behind' | 'slipping' | 'ontrack' | 'ahead';

export interface DeckHealth {
  key: HealthKey;
  /** 1 (worst) to 5 (best). The meter fills to this. */
  rank: number;
  label: string;
  /** The nudge. One sentence, concrete, and never an accusation. */
  note: string;
}

export interface HealthInput {
  /** Active cards on a real schedule — the only ones a recall figure means anything for. */
  scheduled: number;
  /** Of those, how many are under SLIPPED_AT. */
  slipped: number;
  /** Of those, how many are under LOST_AT. */
  lost: number;
  dueNow: number;
  dailyReviewCap: number;
  /** Days with any review in the last seven. */
  activeLast7: number;
}

export function deckHealth(input: HealthInput): DeckHealth | null {
  const { scheduled, slipped, lost, dueNow, dailyReviewCap, activeLast7 } = input;
  if (scheduled === 0) return null;

  // How many sittings the queue would take at the cap you set. Reported rather than the raw count
  // because "72 due" means nothing until you know what a day is worth.
  const sittings = dueNow / dailyReviewCap;
  const deep = Math.round(sittings);

  // A share as well as a count: five forgotten cards in a deck of forty is a different situation
  // from five in a deck of four hundred, and the count alone would call them the same.
  const lostShare = lost / scheduled;
  const slippedShare = slipped / scheduled;

  /**
   * The note, assembled from whichever facts are true rather than written per state.
   *
   * Every state wants to say the same two things — what has decayed, and how much is waiting —
   * so they are formatted once. Prose per state meant five near-identical sentences whose
   * differences were tone rather than information, and tone is the part you stop reading.
   */
  const parts: string[] = [];
  if (lost > 0) parts.push(`${lost} under ${pct(LOST_AT)} recall`);
  else if (slipped > 0) parts.push(`${slipped} under ${pct(SLIPPED_AT)} recall`);
  else parts.push('nothing decaying');

  if (deep >= 2) parts.push(`~${deep} sittings waiting`);
  else if (dueNow > 0) parts.push(`${dueNow} due`);
  else parts.push('nothing due');

  const note = (extra?: string) => [...parts, ...(extra ? [extra] : [])].join(' \u00b7 ');

  if (lost >= 3 && lostShare >= 0.03) {
    return { key: 'losing', rank: 1, label: 'Losing ground', note: note() };
  }
  if ((slipped >= 5 && slippedShare >= 0.05) || sittings >= 4) {
    return { key: 'behind', rank: 2, label: 'Behind', note: note() };
  }
  if (slipped > 0 || sittings >= 2) {
    return { key: 'slipping', rank: 3, label: 'Slipping', note: note() };
  }
  if (dueNow > 0 || activeLast7 < 4) {
    return { key: 'ontrack', rank: 4, label: 'On track', note: note() };
  }
  // Ahead already implies nothing is due, so the queue half is dropped for the one fact this
  // state exists to report: you keep turning up.
  return {
    key: 'ahead',
    rank: 5,
    label: 'Ahead',
    note: [parts[0], `here ${activeLast7} of the last 7 days`].join(' \u00b7 '),
  };
}
