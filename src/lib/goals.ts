/**
 * What a day of this actually costs.
 *
 * A card needs roughly eight to ten reviews to reach multi-year stability, spread across its
 * life, so the steady-state review load lands at about 8–10× the daily new-card rate —
 * permanently. Twenty new a day is therefore an ambitious setting: left to run, it converges on
 * something like a hundred and fifty reviews a day, well past the cap below.
 *
 * That's a deliberate choice, not an oversight. The deck is fed by Joseph's own writing, so the
 * real constraint is how much he writes rather than how much he can absorb, and a target that
 * clears the whole backlog after a sync beats one that leaves new cards queueing for a fortnight.
 * If due counts start climbing week over week, this is the number to lower.
 */
export const DAILY_NEW = 20;

/**
 * The most reviews a day should ever ask for.
 *
 * Clearing what's due is the real obligation, and on an ordinary day that's well under this. The
 * cap exists for the day you come back to a backlog: grinding three hundred cards is how a deck
 * gets abandoned, and the cards left behind decay by single-digit percentages while they wait.
 * Fifty is about twenty minutes at eight seconds a card.
 */
export const DAILY_REVIEW_CAP = 50;

export interface DayPlan {
  newGoal: number;
  newDone: number;
  newLeft: number;
  reviewGoal: number;
  reviewDone: number;
  reviewLeft: number;
  /** Nothing is owed: the streak's condition, and the only part that isn't optional. */
  cleared: boolean;
  /** Owed and optional both finished. */
  done: boolean;
}

/**
 * Today's plan, from what's waiting and what's already been done.
 *
 * Both goals are capped by what actually exists — a goal of five when there are two cards left
 * is a goal you cannot hit, and an unhittable goal is the fastest way to stop trusting the
 * number.
 */
export function dayPlan(input: {
  newAvailable: number;
  dueNow: number;
  learnedToday: number;
  reviewedToday: number;
}): DayPlan {
  const newGoal = Math.min(DAILY_NEW, input.newAvailable + input.learnedToday);
  const newDone = Math.min(input.learnedToday, newGoal);

  const owed = input.dueNow + input.reviewedToday;
  const reviewGoal = Math.min(DAILY_REVIEW_CAP, owed);
  const reviewDone = Math.min(input.reviewedToday, reviewGoal);

  const cleared = reviewDone >= reviewGoal;
  return {
    newGoal,
    newDone,
    newLeft: Math.max(0, newGoal - newDone),
    reviewGoal,
    reviewDone,
    reviewLeft: Math.max(0, reviewGoal - reviewDone),
    cleared,
    done: cleared && newDone >= newGoal,
  };
}
