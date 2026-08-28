'use client';

import { useState } from 'react';
import { SEV } from '@/components/deck-health';
import { BANDS, bandOf } from '@/lib/health';
import type { Memory, MemoryCard } from '@/lib/queries';

/**
 * Every memory you have, sitting on the one curve they all share.
 *
 * FSRS recall depends on elapsed time only through `t / S`, so there is not a curve per card —
 * there is one curve, and each card is somewhere along it. `x = 1` is by definition the point
 * where recall has fallen to 90%, because that is what stability means. A card's position here is
 * exact: horizontal placement is its own recall, read off the shared curve.
 *
 * Left is just-reviewed, right is on the way out, and the interesting part is the middle — a card
 * is worth reviewing when it is on the verge of being forgotten. Recall it at 99% and the review
 * costs effort and buys almost nothing; recall it at 40% and you are learning it again.
 */

const DOT = 3.5;
const GAP = 9;
/** Dense clusters wrap into extra columns rather than growing a spike up the whole chart. */
const MAX_ROWS = 8;

const W = 600;
const CURVE_TOP = 62;
const CURVE_H = 118;

const pct = (r: number) => Math.floor(r * 100);

function relative(days: number): string {
  const n = Math.round(Math.abs(days));
  if (n === 0) return 'due today';
  return days < 0 ? `${n}d overdue` : `due in ${n}d`;
}

function holds(days: number): string {
  return days < 1 ? 'holds <1d' : `holds ${Math.round(days)}d`;
}

interface Placed {
  card: MemoryCard;
  cx: number;
  cy: number;
}

/**
 * Lay the cards out along the curve.
 *
 * Position is the data; the spread around it is packing. 48 of these currently sit within a
 * percentage point of each other, and drawn strictly on the line they would be one dot with 47
 * hidden underneath. So a cluster fans out symmetrically about the point it belongs to — mostly
 * vertically, which costs nothing, and at most a column or three sideways, which on the widest
 * cluster here shifts a card by about half a percent of recall. The curve stays the spine, and no
 * card is lost behind another.
 */
function place(cards: MemoryCard[], px: (x: number) => number, py: (r: number) => number): Placed[] {
  const bins = new Map<number, MemoryCard[]>();
  for (const c of cards) {
    const key = Math.round(px(c.x) / GAP);
    (bins.get(key) ?? bins.set(key, []).get(key)!).push(c);
  }

  const out: Placed[] = [];
  for (const [key, group] of bins) {
    const cols = Math.ceil(group.length / MAX_ROWS);
    const rows = Math.ceil(group.length / cols);
    const cx0 = key * GAP;
    // The spine passes through the middle of the cluster, so the curve stays legible through it.
    const cy0 = py(group.reduce((s, c) => s + c.r, 0) / group.length);

    group.forEach((card, i) => {
      const col = Math.floor(i / rows);
      const row = i % rows;
      out.push({
        card,
        cx: cx0 + (col - (cols - 1) / 2) * GAP,
        cy: cy0 + (row - (rows - 1) / 2) * GAP,
      });
    });
  }
  return out;
}

export function MemoryMap({ memory }: { memory: Memory }) {
  const [picked, setPicked] = useState<MemoryCard | null>(null);
  const { cards, curve } = memory;

  // Run the curve a little past the worst card so nothing sits on the frame, but never so short
  // that the shape stops being a forgetting curve.
  const worst = cards.reduce((m, c) => Math.max(m, c.x), 0);
  const maxX = Math.max(4, Math.ceil(worst * 1.15));
  const shownCurve = curve.filter((p) => p.x <= maxX);
  const rMin = shownCurve[shownCurve.length - 1].r;

  const px = (x: number) => 4 + (Math.min(x, maxX) / maxX) * (W - 8);
  const py = (r: number) =>
    CURVE_TOP + (1 - (Math.max(r, rMin) - rMin) / (1 - rMin)) * CURVE_H;

  const placed = place(cards, px, py);

  // Crop to what is actually drawn. A fixed height had to reserve room for the tallest cluster
  // wherever it might land, and the tallest cluster is only ever in one place — so most decks
  // would have paid for a band of empty chart above and below.
  const ys = placed.map((p) => p.cy);
  const top = Math.min(CURVE_TOP, ...ys) - DOT - 6;
  const bottom = Math.max(CURVE_TOP + CURVE_H, ...ys) + DOT + 6;
  const labelY = bottom + 13;

  const d = shownCurve
    .map((p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)} ${py(p.r).toFixed(1)}`)
    .join(' ');

  const shown = picked ?? cards[0];
  const shownBand = shown ? bandOf(shown.r) : null;

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        {BANDS.map((band) => {
          const n = cards.filter((c) => bandOf(c.r).key === band.key).length;
          return (
            <span
              key={band.key}
              className={`flex items-center gap-1.5 text-[0.6875rem] ${n ? 'text-ink-3' : 'text-ink-4'}`}
            >
              <span className={`h-[7px] w-[7px] rounded-full ${n ? SEV[band.sev].bg : 'bg-ink-4'}`} />
              {band.label}
              <span className="font-mono tabular-nums">{n}</span>
            </span>
          );
        })}
      </div>

      <svg
        viewBox={`0 ${top} ${W} ${labelY + 4 - top}`}
        className="mt-2 h-auto w-full"
        onMouseLeave={() => setPicked(null)}
        role="img"
        aria-label={`${cards.length} learned cards placed on the forgetting curve by current recall.`}
      >
        {/* The two lines that mean something: 90% is what the scheduler aims for at the due date,
            80% is where a card counts as slipped. */}
        {[0.9, 0.8].map((r) =>
          r > rMin ? (
            <g key={r}>
              <line x1={0} x2={W} y1={py(r)} y2={py(r)} className="stroke-ink-4" strokeWidth={1}
                strokeDasharray="2 4" />
              <text x={W - 2} y={py(r) - 4} textAnchor="end" className="fill-ink-4 font-mono" fontSize={9}>
                {pct(r)}%
              </text>
            </g>
          ) : null,
        )}

        <path d={d} fill="none" className="stroke-ink-4" strokeWidth={1.5} />

        {placed.map(({ card, cx, cy }) => {
          const band = bandOf(card.r);
          const on = shown?.id === card.id;
          return (
            <circle
              key={card.id}
              cx={cx}
              cy={cy}
              r={on ? DOT + 2 : DOT}
              className={`${SEV[band.sev].fill} cursor-pointer`}
              onMouseEnter={() => setPicked(card)}
              onClick={() => setPicked(card)}
            >
              <title>{`${pct(card.r)}% · ${card.asks}`}</title>
            </circle>
          );
        })}

        <text x={4} y={labelY} className="fill-ink-4 font-mono" fontSize={9}>
          just reviewed
        </text>
        <text x={W - 2} y={labelY} textAnchor="end" className="fill-ink-4 font-mono" fontSize={9}>
          on the way out
        </text>
      </svg>

      {/* A fixed slot rather than a floating tooltip: it cannot be clipped, cannot cover the dot
          you are pointing at, and holds still long enough to read. */}
      {shown && shownBand && (
        <div className="mt-1 border-l-2 border-ink-4 pl-4">
          <p className="line-clamp-2 text-sm leading-snug text-ink-2">{shown.asks}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 text-[0.6875rem] text-ink-4">
            <span className={SEV[shownBand.sev].text}>
              {pct(shown.r)}% recall · {shownBand.label}
            </span>
            <span className="font-mono tabular-nums">
              {holds(shown.stability)} · {relative(shown.dueInDays)}
            </span>
            {shown.note && <span className="truncate">{shown.note}</span>}
          </p>
        </div>
      )}
    </div>
  );
}
