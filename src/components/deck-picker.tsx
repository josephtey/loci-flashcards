import Link from 'next/link';
import type { DeckCounts } from '@/lib/queries';

/**
 * Pick a deck instead of taking the queue as it comes.
 *
 * The goals above hand you whatever is oldest across the whole deck, which is the right default
 * — the scheduler knows what is about to be forgotten better than a mood does. But "I want to do
 * the bio ones today" is a real request, and the only way to honour it without this was to page
 * through everything else first. Each row is one deck (a vault folder) with what it is holding,
 * and each count is a link into a session drawn from that deck alone.
 *
 * Only decks with something waiting are shown, and a count of zero is not a link: a session
 * with nothing in it is not a choice.
 */
export function DeckPicker({ decks, dailyNew, dailyReviewCap }: {
  decks: DeckCounts[];
  dailyNew: number;
  dailyReviewCap: number;
}) {
  // One deck is the whole queue; a picker with one option is just a second copy of the numbers.
  if (decks.length < 2) return null;

  return (
    <div className="mt-10 sm:mt-12">
      <p className="text-xs uppercase tracking-[0.18em] text-ink-4">Or pick a deck</p>
      <ul className="mt-4 divide-y divide-ink-4/60">
        {decks.map((d) => (
          <li
            key={d.deck}
            className="flex flex-wrap items-baseline gap-x-5 gap-y-1 py-2.5 text-sm"
          >
            <span className="min-w-0 flex-1 truncate text-ink-2">{d.deck}</span>
            <DeckAction
              count={d.newCards}
              cap={dailyNew}
              href={`/new?deck=${encodeURIComponent(d.deck)}`}
              verb="learn"
            />
            <DeckAction
              count={d.dueNow}
              cap={dailyReviewCap}
              href={`/review?deck=${encodeURIComponent(d.deck)}`}
              verb="review"
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One of the two numbers on a deck row. The count shown is what the deck holds; the session it
 * opens is still capped at a day's worth, which is what makes the link honest rather than a
 * promise of a hundred-card sitting.
 */
function DeckAction({
  count,
  cap,
  href,
  verb,
}: {
  count: number;
  cap: number;
  href: string;
  verb: string;
}) {
  if (count === 0 || cap === 0) {
    return (
      <span className="w-24 text-right text-xs tabular-nums text-ink-4 sm:w-28">
        <span className="opacity-60">0 to {verb}</span>
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="w-24 text-right text-xs tabular-nums text-ink-3 transition-colors hover:text-ink sm:w-28"
    >
      {count} to {verb} <span className="text-ink-4">→</span>
    </Link>
  );
}
