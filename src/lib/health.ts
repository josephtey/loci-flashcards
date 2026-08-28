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

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Which state the deck is in.
 *
 * Returns null when there is nothing to judge — a deck with no card yet past its first sitting
 * has no memory to have lost, and "ahead" would be a compliment on an empty room.
 */
export function deckHealth(input: HealthInput): DeckHealth | null {
  const { scheduled, slipped, lost, dueNow, dailyReviewCap, activeLast7 } = input;
  if (scheduled === 0) return null;

  // How many sittings the queue would take at the cap you set. Reported rather than the raw
  // count because "72 due" means nothing until you know what a day is worth.
  const sittings = dueNow / dailyReviewCap;
  const deep = Math.round(sittings);

  // A share as well as a count: five forgotten cards in a deck of forty is a different situation
  // from five in a deck of four hundred, and the count alone would call them the same.
  const lostShare = lost / scheduled;
  const slippedShare = slipped / scheduled;

  if (lost >= 3 && lostShare >= 0.03) {
    return {
      key: 'losing',
      rank: 1,
      label: 'Losing ground',
      note:
        `${plural(lost, 'card has', 'cards have')} fallen under ${Math.round(LOST_AT * 100)}% recall. ` +
        `At that point ${lost === 1 ? 'it comes' : 'they come'} back close to new, so the cheapest ` +
        `thing you can do is start today — not wait until you can clear the whole queue.`,
    };
  }

  if ((slipped >= 5 && slippedShare >= 0.05) || sittings >= 4) {
    const decay = slipped >= 5 && slippedShare >= 0.05;
    return {
      key: 'behind',
      rank: 2,
      label: 'Behind',
      note: decay
        ? `${plural(slipped, 'card is', 'cards are')} under ${Math.round(SLIPPED_AT * 100)}% recall and still waiting. ` +
          `${slipped === 1 ? "It's the one" : "Those are the ones"} worth doing first — everything else is holding.`
        : `The queue is about ${plural(deep, 'sitting', 'sittings')} deep. Nothing has decayed yet, ` +
          `which is the good news and also the reason not to leave it much longer.`,
    };
  }

  if (slipped > 0 || sittings >= 2) {
    return {
      key: 'slipping',
      rank: 3,
      label: 'Slipping',
      note:
        slipped > 0
          ? `${plural(slipped, 'card has', 'cards have')} drifted under ${Math.round(SLIPPED_AT * 100)}% recall. ` +
            `Still cheap to get back — ${slipped === 1 ? "one good answer and it's" : 'one good answer each and'} ` +
            `${slipped === 1 ? '' : "they're "}right again.`
          : `About ${plural(deep, 'sitting', 'sittings')} waiting, though every memory is still where ` +
            `it should be. A session today keeps it that way.`,
    };
  }

  if (dueNow > 0 || activeLast7 < 4) {
    return {
      key: 'ontrack',
      rank: 4,
      label: 'On track',
      // These two states share the page with a large ✓ that already says the queue is clear, so
      // they lead with the thing only this line knows: the state of the memory behind it.
      note:
        dueNow > 0
          ? `Every memory in the deck is where it should be, with ${plural(dueNow, 'card', 'cards')} due. ` +
            `This is what keeping up looks like.`
          : 'Every memory in the deck is where it should be.',
    };
  }

  return {
    key: 'ahead',
    rank: 5,
    label: 'Ahead',
    note:
      `Every memory where it should be, nothing due, and you've been here ${activeLast7} of the ` +
      `last 7 days. The deck is doing what it's for.`,
  };
}
