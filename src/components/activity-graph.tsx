'use client';

import { useEffect, useRef, useState } from 'react';
import { DayDetail } from '@/components/day-detail';
import { DAILY_REVIEW_CAP } from '@/lib/goals';
import type { Activity } from '@/lib/queries';

/**
 * A year of review activity, one square per day.
 *
 * Intensity is bucketed against a daily target rather than against your own maximum. A relative
 * scale would make a heavy day permanently dim the ordinary ones, which is exactly backwards for
 * a habit you want to be unremarkable — the point is that a normal day looks like a normal day.
 */
const TARGET = DAILY_REVIEW_CAP;

function level(reviews: number): number {
  if (reviews === 0) return 0;
  if (reviews < TARGET * 0.35) return 1;
  if (reviews < TARGET * 0.75) return 2;
  if (reviews < TARGET * 1.5) return 3;
  return 4;
}

const FILL = [
  'bg-ink-4/40',
  'bg-mem-long/25',
  'bg-mem-long/45',
  'bg-mem-long/70',
  'bg-mem-long',
] as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function ActivityGraph({ activity }: { activity: Activity }) {
  const { days, streak, longestStreak, todayReviews, todayLearned } = activity;
  const scroller = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<string | null>(null);

  // Pad to a whole week so columns line up on Sundays. Derived from the first day's own date —
  // reading the clock during render would make the component impure and its output unstable.
  const lead = days[0] ? new Date(`${days[0].date}T00:00:00`).getDay() : 0;
  const cells: (typeof days)[number][] = [
    ...Array.from({ length: lead }, () => ({ date: '', reviews: 0, learned: 0, owed: 0, met: false })),
    ...days,
  ];

  const weeks: (typeof cells)[] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  // Today lives at the far right, and today is what you came to look at. Starting the view a year
  // in the past means every visit opens on the one stretch of the graph that can no longer change.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);

  const last30 = days.slice(-30);
  const activeDays = last30.filter((d) => d.reviews > 0).length;
  const avg = activeDays ? Math.round(last30.reduce((s, d) => s + d.reviews, 0) / activeDays) : 0;

  return (
    <div className="w-full min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <span className="text-2xl font-light tabular-nums">
          {streak}
          <span className="ml-2 text-xs uppercase tracking-[0.18em] text-ink-3">
            day{streak === 1 ? '' : 's'} in a row
          </span>
        </span>
        {todayReviews > 0 ? (
          <span className="text-xs text-ink-3">
            today: {todayReviews} reviewed
            {todayLearned > 0 && `, ${todayLearned} learned`}
          </span>
        ) : (
          <span className="text-xs text-ink-3">nothing today yet</span>
        )}
        <span className="text-[0.6875rem] text-ink-4">
          a day counts when nothing is left owed
        </span>
      </div>

      {/* min-w-0 on every ancestor of the scroller, or the grid's intrinsic width wins and the
          whole page scrolls sideways instead of this strip. */}
      <div className="mt-5 w-full min-w-0 overflow-hidden">
        <div ref={scroller} className="w-full overflow-x-auto pb-1">
          <div className="flex w-max gap-[3px]">
            {weeks.map((week, i) => {
              // Label a column when its first real day opens a month.
              const first = week.find((d) => d.date);
              const day = first ? Number(first.date.slice(8, 10)) : 0;
              const label = day >= 1 && day <= 7 ? MONTHS[Number(first!.date.slice(5, 7)) - 1] : '';
              return (
                <div key={i} className="flex flex-col gap-[3px]">
                  <span className="h-3 font-mono text-[0.5rem] leading-3 text-ink-4">{label}</span>
                  {week.map((d, j) =>
                    d.date ? (
                      <button
                        key={j}
                        onClick={() => setPicked(d.date)}
                        title={`${d.date} · ${d.reviews} reviewed${d.owed ? ` · ${d.owed} left owed` : d.reviews ? '' : ' · nothing owed'}`}
                        aria-label={`${d.date}, ${d.reviews} reviewed`}
                        // A day that owed nothing and did nothing still counts — it just has no
                        // volume to colour. An outline says "kept up" without claiming work.
                        className={`day-cell h-[10px] w-[10px] rounded-[2px] transition-transform hover:scale-150 ${
                          d.reviews === 0 && d.met
                            ? 'bg-transparent ring-1 ring-inset ring-mem-long/35'
                            : FILL[level(d.reviews)]
                        }`}
                      />
                    ) : (
                      <span key={j} className="day-cell h-[10px] w-[10px]" />
                    ),
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 text-[0.6875rem] text-ink-4">
        <span>
          {activeDays}/30 days active{avg > 0 && ` · ~${avg} reviews when you sit down`}
        </span>
        {longestStreak > streak && <span>best run {longestStreak}</span>}
        <span className="flex items-center gap-1.5">
          <span className="h-[10px] w-[10px] rounded-[2px] ring-1 ring-inset ring-mem-long/35" />
          nothing owed
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          less
          {FILL.map((f, i) => (
            <span key={i} className={`h-[10px] w-[10px] rounded-[2px] ${f}`} />
          ))}
          more
        </span>
      </div>

      {picked && <DayDetail date={picked} onClose={() => setPicked(null)} />}
    </div>
  );
}
