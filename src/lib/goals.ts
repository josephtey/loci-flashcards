/**
 * What a day of this actually costs.
 *
 * A card needs roughly eight to ten reviews to reach multi-year stability, spread across its
 * life, so the steady-state review load lands at about 8–10× the daily new-card rate —
 * permanently. Twenty new a day converges on something like a hundred and fifty reviews a day,
 * well past any sane ceiling.
 *
 * That gap is deliberate, not an oversight. The deck is fed by Joseph's own writing, so the real
 * constraint is how much he writes rather than how much he can absorb, and a target that clears
 * the backlog after a sync beats one that leaves new cards queueing for a fortnight. The review
 * ceiling is what keeps that honest: it exists for the day you come back to a pile, because
 * grinding three hundred cards is how a deck gets abandoned, and the cards left behind decay by
 * single-digit percentages while they wait.
 *
 * Both numbers are `dailyNew` and `dailyReviewCap` in the config, so they can be tuned from
 * /methodology without a deploy — this file only does the arithmetic. If due counts climb week
 * over week, the intake is the number to lower.
 */

export interface DayPlan {
  newGoal: number;
  newDone: number;
  newLeft: number;
  reviewGoal: number;
  reviewDone: number;
  reviewLeft: number;
  /** Nothing is owed: the day's real obligation, and the only part that isn't optional. */
  cleared: boolean;
  /** Owed and optional both finished. */
  done: boolean;
}

/**
 * Today's plan, from what's waiting, what's already been done, and the two limits.
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
  dailyNew: number;
  dailyReviewCap: number;
}): DayPlan {
  const newGoal = Math.min(input.dailyNew, input.newAvailable + input.learnedToday);
  const newDone = Math.min(input.learnedToday, newGoal);

  const owed = input.dueNow + input.reviewedToday;
  const reviewGoal = Math.min(input.dailyReviewCap, owed);
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
