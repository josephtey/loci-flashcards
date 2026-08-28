import { SEV } from '@/components/deck-health';
import type { HealthKey } from '@/lib/health';
import { SLIPPED_AT } from '@/lib/health';
import type { Recall } from '@/lib/queries';

/**
 * Where the deck goes over the next month if you review nothing.
 *
 * Two lines, both percentages, because one of them alone would mislead. Mean recall is the
 * classic forgetting curve and it is nearly flat here — 91% to 81% over thirty days — which reads
 * as "everything is fine". It isn't: the deck was learned in cohorts, so a large block shares a
 * stability of about eight days and crosses the 80% line on the same afternoon. The share still
 * above that line falls off a cliff the mean glides straight through.
 *
 * It is a counterfactual and says so. Nothing here predicts the future; it prices the reviews you
 * have not done yet.
 */
const W = 600;
const H = 128;
const PAD_TOP = 10;
const PAD_BOTTOM = 20;
const PLOT = H - PAD_TOP - PAD_BOTTOM;

// Inset both ends: today's marker is a filled circle and sat half outside the viewBox at x=0.
const INSET = 4;
const x = (day: number, days: number) => INSET + (day / days) * (W - INSET * 2);
const y = (v: number) => PAD_TOP + (1 - v) * PLOT;

type Point = Recall['forecast'][number];

const path = (points: Point[], days: number, value: (p: Point) => number) =>
  points
    .map((p, i) => `${i ? 'L' : 'M'}${x(p.day, days).toFixed(1)} ${y(value(p)).toFixed(1)}`)
    .join(' ');

export function ForgettingCurve({
  forecast,
  state,
}: {
  forecast: Recall['forecast'];
  state: HealthKey;
}) {
  const days = forecast[forecast.length - 1]?.day ?? 30;
  const last = forecast[forecast.length - 1];
  const half = forecast.find((f) => f.solid < 0.5);
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  // Whole weeks, plus wherever the horizon actually ends. Quarters of thirty gave 8d and 15d,
  // which are not units anybody thinks in.
  const ticks = [...[0, 7, 14, 21].filter((d) => d < days - 3), days];
  const sev = SEV[state];

  return (
    <div className="mt-6">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img"
        aria-label={`Forgetting curve: ${pct(last.solid)} of the deck is still above ${pct(SLIPPED_AT)} recall in ${days} days if nothing is reviewed.`}>
        {/* The line a card is called slipped at. Everything above it is memory you still have. */}
        <line x1={0} x2={W} y1={y(SLIPPED_AT)} y2={y(SLIPPED_AT)}
          className="stroke-ink-4" strokeWidth={1} strokeDasharray="2 4" />
        <text x={2} y={y(SLIPPED_AT) - 4} className="fill-ink-4 font-mono" fontSize={9}>
          {pct(SLIPPED_AT)}
        </text>

        {ticks.map((d) => (
          <text key={d} x={x(d, days)} y={H - 6}
            textAnchor={d === 0 ? 'start' : d === days ? 'end' : 'middle'}
            className="fill-ink-4 font-mono" fontSize={9}>
            {d === 0 ? 'now' : `${d}d`}
          </text>
        ))}

        {/* Mean recall: the textbook curve, and on its own a flatterer. */}
        <path d={path(forecast, days, (p) => p.mean)} fill="none"
          className="stroke-ink-3" strokeWidth={1.25} strokeDasharray="3 3" />

        {/* The share still above the line. This is the one with the shape. */}
        <path d={path(forecast, days, (p) => p.solid)} fill="none"
          className={sev.stroke} strokeWidth={2} strokeLinejoin="round" />

        {/* Today. `fill-*`, not `currentColor` — a stroke class leaves the fill inheriting the
            page's ink, which put a white dot on the end of a coloured line. */}
        <circle cx={x(0, days)} cy={y(forecast[0].solid)} r={3} className={sev.fill} />
      </svg>

      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-ink-4">
        <span>if you review nothing</span>
        <span className="flex items-center gap-1.5">
          <span className={`h-[2px] w-4 ${sev.bg}`} /> above {pct(SLIPPED_AT)} recall
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-px w-4 bg-current opacity-60" /> mean recall
        </span>
        <span className="text-ink-3">
          {half
            ? `half the deck slips within ${half.day}d`
            : `${pct(last.solid)} still holding at ${days}d`}
        </span>
      </p>
    </div>
  );
}
