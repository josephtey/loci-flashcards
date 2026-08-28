'use client';

import { useEffect, useMemo, useState } from 'react';
import { SEV } from '@/components/deck-health';
import { BANDS, bandOf, LOST_AT, SLIPPED_AT } from '@/lib/health';
import type { Memory, MemoryCard } from '@/lib/queries';

/**
 * Every memory you have, sitting on the one curve they all share.
 *
 * FSRS recall depends on elapsed time only through `t / S`, so there is not a curve per card —
 * there is one curve, and each card is somewhere along it. `x = 1` is by definition the point
 * where recall has fallen to 90%, because that is what stability means.
 *
 * The curve runs the whole way, from just-reviewed to the 60% line where a card is treated as
 * gone. The middle of it is the point of the entire system: a card is worth reviewing when it is
 * on the verge of being forgotten. Recall it at 99% and the review costs effort and buys almost
 * nothing; recall it at 40% and you are learning it again from scratch.
 */

const W = 620;
const TOP = 14;
const PLOT_H = 190;

/** Dot radius by durability. A memory that holds for months is a bigger thing than one that
 *  holds for a day, and the size is also what stops a cluster reading as a lattice. */
const rOf = (stability: number) => 3 + Math.min(1.8, Math.max(0, Math.log10(stability) * 0.95));

const pct = (r: number) => Math.floor(r * 100);

/** How long a card takes to travel, and how much later each one sets off than the last. */
const FLIGHT_MS = 1100;
const STAGGER_MS = 26;
const MAX_STAGGER_MS = 700;

function relative(days: number): string {
  const n = Math.round(Math.abs(days));
  if (n === 0) return 'due today';
  return days < 0 ? `${n}d overdue` : `due in ${n}d`;
}

function holds(days: number): string {
  return days < 1 ? 'holds <1d' : `holds ${Math.round(days)}d`;
}

/** Stable pseudo-random in [-1, 1] from the card's id, so the layout never moves between renders
 *  and the server and the browser agree on it. */
function seed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

interface Node {
  card: MemoryCard;
  x0: number;
  y0: number;
  x: number;
  y: number;
  r: number;
}

/**
 * Settle the cards into place.
 *
 * The previous version packed each cluster into a rectangular lattice, which is the one thing a
 * memory is not: it read as a spreadsheet bolted to a curve. This lets them push each other apart
 * instead — repulsion until nothing overlaps, against a spring pulling each card back to where it
 * actually belongs. Clusters come out as blobs that hug the line, and the shape of a blob says
 * how many cards are piled at that point.
 *
 * The spring on x is stiffer than the one on y, because x is the reading that matters: horizontal
 * position is recall. Measured against this deck, the settled positions sit a median of 0.55
 * percentage points from where the card truly is, and 1.6 at the very worst — and some of even
 * that is the readout being floored rather than the dot being moved.
 */
function settle(cards: MemoryCard[], px: (c: MemoryCard) => number, py: (c: MemoryCard) => number): Node[] {
  const nodes: Node[] = cards.map((card) => {
    const x0 = px(card);
    const y0 = py(card);
    return { card, x0, y0, x: x0 + seed(card.id) * 0.6, y: y0 + seed(card.id + '#') * 3, r: rOf(card.stability) };
  });

  // Two phases. The first settles them against the springs, so every card stays near the recall
  // it actually has. The second drops the springs and separates whatever is still touching —
  // without it a cluster this dense never quite comes apart, because the spring pulling forty
  // cards back to one point is stronger than the push separating them.
  for (let pass = 0; pass < 220; pass++) {
    const springing = pass < 160;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const min = a.r + b.r + 1.4;
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min || d2 === 0) continue;
        const d = Math.sqrt(d2);
        const push = ((min - d) / d) * 0.5;
        // Shove generously in y and half as hard in x: y is packing, x is the reading.
        a.x -= dx * push * 0.55;
        b.x += dx * push * 0.55;
        a.y -= dy * push;
        b.y += dy * push;
      }
    }
    if (!springing) continue;
    for (const n of nodes) {
      n.x += (n.x0 - n.x) * 0.05;
      n.y += (n.y0 - n.y) * 0.008;
    }
  }
  return nodes;
}

export function MemoryMap({ memory }: { memory: Memory }) {
  const [picked, setPicked] = useState<MemoryCard | null>(null);
  const { cards, curve, curveT, maxX } = memory;

  const tMax = curveT;
  const px = (x: number) => 6 + (Math.log1p(Math.min(x, maxX) / 0.15) / tMax) * (W - 12);
  // The plot spans exactly the two thresholds that mean anything: 100% at the top, the 60% line
  // where a card counts as gone at the bottom.
  const py = (r: number) => TOP + (1 - (Math.max(r, LOST_AT) - LOST_AT) / (1 - LOST_AT)) * PLOT_H;

  const nodes = useMemo(
    () => settle(cards, (c) => px(c.x), (c) => py(c.r)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cards, tMax, maxX],
  );

  const todayCount = cards.filter((c) => c.reviewedToday).length;

  /**
   * The same layout, but with today's cards where they were when you sat down.
   *
   * Settled separately rather than by moving dots around the finished layout: a card that has
   * flown back to 85% has to make room among the cards already there, and its old neighbours have
   * to close the gap it left. Only the reviewed ones move — everything else was where it is now.
   */
  const before = useMemo(() => {
    if (!todayCount) return null;
    const laid = settle(
      cards,
      (c) => px(c.before?.x ?? c.x),
      (c) => py(c.before?.r ?? c.r),
    );
    return new Map(laid.map((n) => [n.card.id, n]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, tMax, maxX, todayCount]);

  /**
   * `armed` puts the cards back with the transition switched off, so nothing is seen to jump;
   * `running` turns the transition on and lets them travel to where they actually are.
   */
  const [replay, setReplay] = useState<'idle' | 'armed' | 'running'>('idle');

  useEffect(() => {
    if (replay === 'armed') {
      // Someone who has asked for less motion still gets the information — the cards go back to
      // where they were and hold there for a beat, then return. Two still frames rather than a
      // flight across the chart.
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        const t = setTimeout(() => setReplay('idle'), 1400);
        return () => clearTimeout(t);
      }
      // Two frames: one for the browser to paint the cards in their old places, one to change
      // the target. Inside a single frame it coalesces into no movement at all.
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setReplay('running'));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    if (replay === 'running') {
      const t = setTimeout(() => setReplay('idle'), FLIGHT_MS + MAX_STAGGER_MS + 150);
      return () => clearTimeout(t);
    }
  }, [replay]);

  // Both layouts, not just the settled one: during a replay a card is somewhere it no longer
  // belongs, and a frame sized only to where things end up would clip it on the way in.
  const spread = [...nodes, ...(before ? before.values() : [])];
  const top = Math.min(TOP, ...spread.map((n) => n.y - n.r)) - 6;
  const bottom = Math.max(TOP + PLOT_H, ...spread.map((n) => n.y + n.r)) + 6;
  const labelY = bottom + 13;

  const d = curve.map((p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)} ${py(p.r).toFixed(1)}`).join(' ');

  /** Where along the curve recall has fallen to `target`, read off the sampled curve itself. */
  const xAt = (target: number) => {
    const i = curve.findIndex((p) => p.r <= target);
    if (i <= 0) return curve[0].x;
    const a = curve[i - 1];
    const b = curve[i];
    return a.x + ((b.x - a.x) * (a.r - target)) / (a.r - b.r);
  };
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

        {/* Today's work, in its own colour and on its own side of the row — it is not a sixth
            band, it is a different question about the same dots. */}
        {todayCount > 0 && (
          <button
            onClick={() => setReplay('armed')}
            disabled={replay !== 'idle'}
            title="Put today's cards back where they were this morning, and watch them return"
            className="ml-auto flex items-center gap-1.5 text-[0.6875rem] text-ink-3 transition-colors hover:text-ink disabled:opacity-60"
          >
            <span className="h-[7px] w-[7px] rounded-full ring-[1.5px] ring-today ring-inset" />
            reviewed today
            <span className="font-mono tabular-nums">{todayCount}</span>
            <span className="text-today">{replay === 'idle' ? '· replay' : '· ↑'}</span>
          </button>
        )}
      </div>

      <svg
        viewBox={`0 ${top} ${W} ${labelY + 4 - top}`}
        className="mt-2 h-auto w-full"
        onMouseLeave={() => setPicked(null)}
        role="img"
        aria-label={`${cards.length} learned cards placed on the forgetting curve by current recall.`}
      >
        {/* The verge, marked across x rather than across y.
            Both axes encode recall here — a card sits on a one-dimensional curve, so displacing
            it to stop it hiding behind another card moves it off the line in some direction. x is
            the reading that survives that (a median of half a percentage point out), y is not. A
            horizontal band would have told you a card packed below the 80% line was slipping when
            it is not. This one is true: everything inside it is between 90% and 80%. */}
        <rect x={px(xAt(0.9))} y={top} width={px(xAt(SLIPPED_AT)) - px(xAt(0.9))} height={bottom - top}
          className="fill-sev-3" opacity={0.08} />
        <text x={(px(xAt(0.9)) + px(xAt(SLIPPED_AT))) / 2} y={top + 10} textAnchor="middle"
          className="fill-sev-3 font-mono" fontSize={9} opacity={0.9}>
          the verge — review here
        </text>

        {[0.9, SLIPPED_AT, LOST_AT].map((r) => (
          <g key={r}>
            <line x1={0} x2={W} y1={py(r)} y2={py(r)} className="stroke-ink-4" strokeWidth={1}
              strokeDasharray="2 4" />
            <text x={W - 2} y={py(r) - 4} textAnchor="end" className="fill-ink-4 font-mono" fontSize={9}>
              {pct(r)}%
            </text>
          </g>
        ))}

        <path d={d} fill="none" className="stroke-ink-3" strokeWidth={1.25} opacity={0.55} />

        {nodes.map(({ card, x, y, r }, i) => {
          const band = bandOf(card.r);
          const on = shown?.id === card.id;
          const back = replay === 'armed' && before ? before.get(card.id) : null;
          const at = back ?? { x, y };
          // Only today's cards travel, so only they need staggering — and staggering by their
          // index among *all* cards would leave most of the delay budget on cards standing still.
          const delay = Math.min(MAX_STAGGER_MS, i * STAGGER_MS);
          return (
            <g
              key={card.id}
              transform={`translate(${at.x.toFixed(1)} ${at.y.toFixed(1)})`}
              style={
                replay === 'running' && card.reviewedToday
                  ? { transition: `transform ${FLIGHT_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1) ${delay}ms` }
                  : undefined
              }
            >
              <circle
                cx={0}
                cy={0}
                r={on ? r + 2.5 : r}
                className={`${SEV[band.sev].fill} cursor-pointer`}
                // While a replay is on, everything that did not move gets out of the way.
                opacity={replay !== 'idle' && !card.reviewedToday ? 0.18 : on ? 1 : 0.88}
                stroke={card.reviewedToday ? 'var(--today)' : undefined}
                strokeWidth={card.reviewedToday ? 1.6 : undefined}
                onMouseEnter={() => setPicked(card)}
                onClick={() => setPicked(card)}
              >
                <title>{`${pct(card.r)}% · ${card.asks}`}</title>
              </circle>
            </g>
          );
        })}

        <text x={6} y={labelY} className="fill-ink-4 font-mono" fontSize={9}>
          just reviewed
        </text>
        <text x={W - 2} y={labelY} textAnchor="end" className="fill-ink-4 font-mono" fontSize={9}>
          probably forgotten
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
