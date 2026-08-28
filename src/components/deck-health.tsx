import type { DeckHealth, HealthKey } from '@/lib/health';

/**
 * One line on how the deck is doing, on a five-step scale.
 *
 * Red through green, on the severity ramp rather than the memory-horizon one. The memory palette
 * was the wrong borrow: there, warm means a memory is young, and a young memory is not bad news.
 * Here warm means bad news, which is the only thing the colour is being asked to say.
 *
 * The meter carries the rank, five squares in the same idiom as the activity legend, so "third
 * of five" is legible without having to learn how the words rank against each other.
 */
export const SEV: Record<
  HealthKey,
  { bg: string; text: string; border: string; stroke: string; fill: string }
> = {
  losing: { bg: 'bg-sev-1', text: 'text-sev-1', border: 'border-sev-1', stroke: 'stroke-sev-1', fill: 'fill-sev-1' },
  behind: { bg: 'bg-sev-2', text: 'text-sev-2', border: 'border-sev-2', stroke: 'stroke-sev-2', fill: 'fill-sev-2' },
  slipping: { bg: 'bg-sev-3', text: 'text-sev-3', border: 'border-sev-3', stroke: 'stroke-sev-3', fill: 'fill-sev-3' },
  ontrack: { bg: 'bg-sev-4', text: 'text-sev-4', border: 'border-sev-4', stroke: 'stroke-sev-4', fill: 'fill-sev-4' },
  ahead: { bg: 'bg-sev-5', text: 'text-sev-5', border: 'border-sev-5', stroke: 'stroke-sev-5', fill: 'fill-sev-5' },
};

export function DeckHealthLine({ health, mean }: { health: DeckHealth; mean: number }) {
  const tone = SEV[health.key];

  return (
    <div
      className={`mt-8 flex flex-wrap items-center gap-x-3 gap-y-2 border-l-2 pl-4 sm:mt-10 ${tone.border}`}
    >
      <span
        className="flex items-center gap-[3px]"
        role="img"
        aria-label={`${health.label}: ${health.rank} out of 5`}
      >
        {[1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            className={`h-[10px] w-[10px] rounded-[2px] ${i <= health.rank ? tone.bg : 'bg-ink-4/60'}`}
          />
        ))}
      </span>
      <span className={`text-xs uppercase tracking-[0.18em] ${tone.text}`}>{health.label}</span>
      <span className="text-xs text-ink-3">{health.note}</span>
      {/* The figure the whole state is derived from. It is the one number on this page that is
          about memory rather than about a queue, so it is worth saying even when nothing is wrong. */}
      <span className="font-mono text-[0.625rem] tabular-nums text-ink-4">
        {Math.round(mean * 100)}% recall
      </span>
    </div>
  );
}
