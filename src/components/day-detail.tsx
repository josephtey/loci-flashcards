'use client';

import { useEffect, useState } from 'react';
import { renderCloze } from '@/lib/cloze';

interface DayReview {
  id: string;
  action: string;
  rating: number | null;
  ratingLabel: string | null;
  wasNew: boolean;
  durationMs: number | null;
  at: string;
  front: string;
  back: string | null;
  cloze_text: string | null;
  type: string;
  angle: string;
  note: string | null;
}

/** Again reads as a miss, Easy as a runaway — the middle two are the healthy band. */
const RATING_COLOR: Record<number, string> = {
  1: 'text-mem-fresh',
  2: 'text-mem-short',
  3: 'text-mem-long',
  4: 'text-mem-medium',
};

/**
 * One day, opened up.
 *
 * The square on the graph says you showed up; this says how it went. Which is the more useful
 * question on an unusually heavy day, or a day where the streak survived but the recall didn't —
 * and the only way to see *which cards* were the problem.
 */
export function DayDetail({ date, onClose }: { date: string; onClose: () => void }) {
  const [reviews, setReviews] = useState<DayReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/activity/day?date=${date}`)
      .then((r) => r.json())
      .then((d: { reviews: DayReview[] }) => live && setReviews(d.reviews))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [date]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const graded = reviews?.filter((r) => r.action === 'grade') ?? [];
  const again = graded.filter((r) => r.rating === 1).length;
  const learned = graded.filter((r) => r.wasNew).length;
  const dropped = reviews?.filter((r) => r.action === 'drop').length ?? 0;
  const totalMs = graded.reduce((s, r) => s + (r.durationMs ?? 0), 0);
  const recall = graded.length ? Math.round(((graded.length - again) / graded.length) * 100) : null;

  const heading = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/95 px-6 py-10 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="rise flex h-full w-full max-w-2xl flex-col"
      >
        <div className="flex shrink-0 items-baseline justify-between gap-4">
          <div>
            <h2 className="text-lg font-light">{heading}</h2>
            <p className="mt-1 text-xs text-ink-3">
              {reviews === null
                ? 'Loading…'
                : graded.length === 0
                  ? 'Nothing reviewed this day'
                  : [
                      `${graded.length} reviewed`,
                      learned > 0 && `${learned} learned`,
                      recall !== null && `${recall}% recalled`,
                      totalMs > 0 && `${Math.round(totalMs / 60000)} min`,
                      dropped > 0 && `${dropped} dropped`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
            </p>
          </div>
          <button onClick={onClose} className="text-sm text-ink-3 hover:text-ink">
            Close
          </button>
        </div>

        <div className="card-quiet mt-5 min-h-0 flex-1 overflow-y-auto">
          {error && <p className="p-6 text-sm text-ink-2">{error}</p>}

          {reviews !== null && reviews.length === 0 && (
            <p className="p-6 text-sm text-ink-3">
              A quiet day. Nothing was reviewed — no cards were due, or none were done.
            </p>
          )}

          {(reviews ?? []).map((r) => {
            const isCloze = r.type === 'cloze' && r.cloze_text;
            const q = isCloze ? renderCloze(r.cloze_text!, false) : r.front;
            const a = isCloze ? renderCloze(r.cloze_text!, true) : r.back;
            const open = expanded === r.id;
            return (
              <button
                key={r.id}
                onClick={() => setExpanded(open ? null : r.id)}
                className="block w-full border-b border-ink-4/50 px-5 py-3 text-left last:border-0 hover:bg-white/[0.02]"
              >
                <div className="flex items-baseline gap-3">
                  <span className="w-11 shrink-0 font-mono text-[0.625rem] tabular-nums text-ink-4">
                    {new Date(r.at).toLocaleTimeString(undefined, {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-2">{q}</span>
                  {r.wasNew && (
                    <span className="shrink-0 font-mono text-[0.5625rem] uppercase tracking-wider text-mem-new">
                      new
                    </span>
                  )}
                  <span
                    className={`w-12 shrink-0 text-right font-mono text-[0.625rem] ${
                      r.action !== 'grade'
                        ? 'text-ink-4'
                        : (RATING_COLOR[r.rating ?? 0] ?? 'text-ink-4')
                    }`}
                  >
                    {r.action === 'grade' ? r.ratingLabel : r.action}
                  </span>
                </div>
                {open && (
                  <div className="rise mt-3 pl-14">
                    {a && <p className="text-sm leading-relaxed text-ink-3">{a}</p>}
                    <p className="mt-2 font-mono text-[0.5625rem] uppercase tracking-wider text-ink-4">
                      {r.angle}
                      {r.note && ` · ${r.note}`}
                      {r.durationMs != null && ` · ${(r.durationMs / 1000).toFixed(1)}s`}
                    </p>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
