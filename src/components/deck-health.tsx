import type { DeckHealth, HealthKey } from '@/lib/health';

/**
 * One line on how the deck is doing, on a five-step scale.
 *
 * The colours are the app's own memory-horizon ramp, in its own order — fresh, short, medium,
 * long. That palette already means "how well established is this memory", which is exactly what
 * the status is reporting, so a deck losing ground wears the same orange as a card that has only
 * just been learned.
 *
 * The meter carries the rank, five squares in the same idiom as the activity legend, so "third
 * of five" is legible without having to learn how the words rank against each other.
 */
const TONE: Record<HealthKey, { fill: string; label: string; rule: string }> = {
  losing: { fill: 'bg-mem-fresh', label: 'text-mem-fresh', rule: 'border-mem-fresh' },
  behind: { fill: 'bg-mem-short', label: 'text-mem-short', rule: 'border-mem-short' },
  slipping: { fill: 'bg-mem-medium', label: 'text-mem-medium', rule: 'border-mem-medium' },
  ontrack: { fill: 'bg-mem-long', label: 'text-mem-long', rule: 'border-mem-long' },
  ahead: { fill: 'bg-mem-long', label: 'text-mem-long', rule: 'border-mem-long' },
};

export function DeckHealthLine({ health, mean }: { health: DeckHealth; mean: number }) {
  const tone = TONE[health.key];

  return (
    <div
      className={`mt-8 flex flex-wrap items-center gap-x-3 gap-y-2 border-l-2 pl-4 sm:mt-10 ${tone.rule}`}
    >
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
      <span className="text-xs text-ink-3">{health.note}</span>
      {/* The figure the whole state is derived from. It is the one number on this page that is
          about memory rather than about a queue, so it is worth saying even when nothing is wrong. */}
      <span className="font-mono text-[0.625rem] tabular-nums text-ink-4">
        {Math.round(mean * 100)}% recall
      </span>
    </div>
  );
}
