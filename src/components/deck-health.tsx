import type { DeckHealth, HealthKey } from '@/lib/health';

/**
 * One line on how the deck is doing, on a five-step scale.
 *
 * Colour is deliberately not a five-step ramp. Only the two states that want something from you
 * are coloured; the rest are ink or the same quiet green the activity graph uses. A page that
 * lights up green for doing nothing wrong is a page you stop reading, and this one has to be
 * worth reading on the day it turns orange.
 *
 * The meter carries the rank instead — five squares, the same idiom as the activity legend, so
 * "third of five" is legible without having to learn what the words mean relative to each other.
 */
const TONE: Record<HealthKey, { fill: string; label: string; rule: string }> = {
  losing: { fill: 'bg-mem-fresh', label: 'text-mem-fresh', rule: 'border-mem-fresh/60' },
  behind: { fill: 'bg-mem-short', label: 'text-mem-short', rule: 'border-mem-short/60' },
  slipping: { fill: 'bg-ink-2', label: 'text-ink-2', rule: 'border-ink-2/40' },
  ontrack: { fill: 'bg-mem-long/60', label: 'text-ink-2', rule: 'border-mem-long/30' },
  ahead: { fill: 'bg-mem-long', label: 'text-mem-long', rule: 'border-mem-long/50' },
};

export function DeckHealthLine({ health, mean }: { health: DeckHealth; mean: number }) {
  const tone = TONE[health.key];

  return (
    <div className={`mt-8 border-l-2 pl-4 sm:mt-10 ${tone.rule}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className="flex items-center gap-[3px]"
          role="img"
          aria-label={`${health.label}: ${health.rank} out of 5`}
        >
          {[1, 2, 3, 4, 5].map((i) => (
            <span
              key={i}
              className={`h-[10px] w-[10px] rounded-[2px] ${i <= health.rank ? tone.fill : 'bg-ink-4/60'}`}
            />
          ))}
        </span>
        <span className={`text-xs uppercase tracking-[0.18em] ${tone.label}`}>{health.label}</span>
        {/* The number the whole state is derived from, said plainly. It is the one figure here
            that is about memory rather than about a queue, and it belongs next to the verdict
            rather than buried in a tooltip. */}
        <span className="font-mono text-[0.625rem] tabular-nums text-ink-4">
          {Math.round(mean * 100)}% mean recall
        </span>
      </div>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-3">{health.note}</p>
    </div>
  );
}
