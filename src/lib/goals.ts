/**
 * What a day of this actually costs.
 *
 * A card needs roughly eight to ten reviews to reach multi-year stability, spread across its
 * life. So the steady-state review load is about 8–10× the daily new-card rate — permanently.
 * Five new a day settles at forty-odd reviews a day, ten or fifteen minutes; ten new a day
 * settles at eighty to a hundred, which is where people quit. The number that matters is the one
 * you can hit on a bad day.
 *
 * Anki's default of twenty new a day is calibrated for a medical student grinding a twenty-
 * thousand-card premade deck against a fixed exam date. This deck is Joseph's own writing, and
 * the binding constraint is how much he writes, not how much he can absorb.
 */
export const DAILY_NEW = 5;

/**
 * The most reviews a day should ever ask for.
 *
 * Clearing what's due is the real obligation, and on an ordinary day that's well under this. The
 * cap exists for the day you come back to a backlog: grinding three hundred cards is how a deck
 * gets abandoned, and the cards left behind decay by single-digit percentages while they wait.
 */
export const DAILY_REVIEW_CAP = 40;

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
