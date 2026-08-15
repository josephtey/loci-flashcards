import Link from 'next/link';
import { ActivityGraph } from '@/components/activity-graph';
import { HomeSync } from '@/components/home-sync';
import { vaultStatus } from '@/lib/environment';
import { dayPlan } from '@/lib/goals';
import { activity, counts } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * One half of today's plan.
 *
 * The headline number is what's *left*, not what exists. A total is a standing accusation — it
 * only ever goes up when you write more, so it reads as debt however much work you do. What's
 * left today is a number you can drive to zero, which is the only kind worth putting in 48px.
 */
function Goal({
  left,
  done,
  goal,
  label,
  action,
  href,
}: {
  left: number;
  done: number;
  goal: number;
  label: string;
  action: string;
  href: string;
}) {
  const finished = left === 0;

  return (
    <div className={finished ? 'opacity-45' : undefined}>
      <div className="flex items-baseline gap-2">
        <span className="text-4xl font-light tabular-nums sm:text-5xl">{finished ? '✓' : left}</span>
        {goal > 0 && (
          <span className="font-mono text-[0.625rem] tabular-nums text-ink-4">
            {done}/{goal}
          </span>
        )}
      </div>
      <div className="mt-2 text-xs uppercase tracking-[0.18em] text-ink-3">{label}</div>
      {finished ? (
        <span className="mt-4 inline-block text-sm text-ink-4">done</span>
      ) : (
        <Link
          href={href}
          className="mt-4 inline-block text-sm text-ink-2 transition-colors hover:text-ink"
        >
          {action} <span className="text-ink-3">→</span>
        </Link>
      )}
    </div>
  );
}

export default async function Home() {
  const [c, a, vault] = await Promise.all([counts(), activity(), vaultStatus()]);

  const plan = dayPlan({
    newAvailable: c.newCards,
    dueNow: c.dueNow,
    learnedToday: a.todayLearned,
    reviewedToday: a.todayReviews - a.todayLearned,
  });

  return (
    <main className="safe-b relative mx-auto flex min-h-dvh w-full max-w-2xl flex-col justify-center px-5 pb-28 pt-14 sm:px-8 sm:pb-40 sm:pt-20">
      <Link
        href="/methodology"
        className="absolute right-5 top-6 text-[0.6875rem] uppercase tracking-[0.2em] text-ink-3 transition-colors hover:text-ink sm:right-8 sm:top-8 sm:text-xs"
      >
        Methodology
      </Link>

      <div className="rise min-w-0">
        <h1 className="text-sm uppercase tracking-[0.35em] text-ink-3">Loci</h1>

        {/* ── today ──────────────────────────────────────────────────────── */}
        {plan.cleared ? (
          <div className="mt-8 sm:mt-10">
            <div className="card flex items-start gap-4 px-5 py-5 sm:gap-5 sm:px-7 sm:py-6">
              <span className="mt-0.5 text-2xl leading-none text-mem-long">✓</span>
              <div className="min-w-0">
                <p className="text-xl font-light leading-snug sm:text-2xl">
                  {plan.done ? "You've done enough for today" : 'Nothing owed today'}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-ink-3">
                  {plan.done
                    ? `Everything due is cleared${plan.newGoal > 0 ? ` and today's ${plan.newGoal} new card${plan.newGoal === 1 ? '' : 's'} are in` : ''}.`
                    : `Everything due is cleared. ${plan.newLeft} new card${plan.newLeft === 1 ? '' : 's'} waiting if you want ${plan.newLeft === 1 ? 'it' : 'them'} — the day already counts either way.`}
                  {a.streak > 0 && (
                    <span className="text-ink-2">
                      {' '}
                      That&rsquo;s {a.streak} day{a.streak === 1 ? '' : 's'} in a row.
                    </span>
                  )}
                </p>
              </div>
            </div>

            {/* Stopping here is the recommendation, not a rule. Carrying on is one click away —
                just labelled honestly, since tomorrow's session is where it comes from. */}
            {(c.dueNow > 0 || c.newCards > 0) && (
              <div className="mt-6 flex flex-wrap items-baseline gap-x-6 gap-y-2">
                <span className="text-xs text-ink-4">Want to keep going?</span>
                {c.dueNow > 0 && (
                  <Link
                    href="/review"
                    className="text-sm text-ink-3 transition-colors hover:text-ink"
                  >
                    Review {c.dueNow} more <span className="text-ink-4">→</span>
                  </Link>
                )}
                {c.newCards > 0 && (
                  <Link href="/new" className="text-sm text-ink-3 transition-colors hover:text-ink">
                    Learn {c.newCards} more <span className="text-ink-4">→</span>
                  </Link>
                )}
                <span className="text-[0.6875rem] text-ink-4">
                  every extra card today is one you owe tomorrow
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-8 sm:mt-10">
            <p className="text-xs uppercase tracking-[0.18em] text-ink-4">Today</p>
            <div className="mt-6 grid grid-cols-2 gap-6 sm:gap-10">
              <Goal
                left={plan.newLeft}
                done={plan.newDone}
                goal={plan.newGoal}
                label="to learn"
                action="Start learning"
                href="/new"
              />
              <Goal
                left={plan.reviewLeft}
                done={plan.reviewDone}
                goal={plan.reviewGoal}
                label="to review"
                action="Review now"
                href="/review"
              />
            </div>
          </div>
        )}

        {/* The whole deck, deliberately quiet: it's context, not a to-do list. */}
        <div className="mt-10 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[0.6875rem] text-ink-4">
          <span className="tabular-nums">{c.activeCards} in deck</span>
          <span className="tabular-nums">{c.newCards} never seen</span>
          {c.dueNow > plan.reviewGoal && (
            <span className="tabular-nums">{c.dueNow} due in total</span>
          )}
          {c.needsRewrite > 0 && (
            <span className="tabular-nums">{c.needsRewrite} awaiting rewrite</span>
          )}
          <Link href="/cards" className="transition-colors hover:text-ink-2">
            See all →
          </Link>
        </div>

        <div className="mt-12 min-w-0 border-t border-ink-4 pt-8 sm:mt-16 sm:pt-10">
          <ActivityGraph activity={a} />
        </div>

        <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-ink-4 pt-8 sm:mt-12">
          <HomeSync available={vault.available} reason={vault.reason} />
          {c.lastScan?.finished_at && (
            <span className="ml-auto text-xs text-ink-4">
              last synced{' '}
              {new Date(c.lastScan.finished_at).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              })}
            </span>
          )}
        </div>
      </div>
    </main>
  );
}
