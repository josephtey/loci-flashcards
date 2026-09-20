import Link from 'next/link';
import { deckParam, type SearchParams } from '@/lib/deck-param';
import { explainerStatus, graderStatus } from '@/lib/grader';
import { readConfig } from '@/lib/prompt-store';
import { newCards } from '@/lib/queries';
import { Review } from '../review/review-client';

export const dynamic = 'force-dynamic';

export default async function NewPage({ searchParams }: { searchParams: SearchParams }) {
  // `?deck=` narrows the sitting to one deck (a vault folder). Absent, the queue is what it is.
  const deck = deckParam((await searchParams).deck);

  // Read first: it sets how many new cards a sitting hands you.
  const config = await readConfig();
  const [cards, grader, explainer] = await Promise.all([
    newCards(config.dailyNew, deck),
    graderStatus(),
    explainerStatus(),
  ]);

  if (!cards.length) {
    return (
      <main className="safe-b safe-t [--safe-b-base:2.5rem] [--safe-t-base:2.5rem] flex min-h-dvh flex-col items-center justify-center gap-8 px-6">
        <p className="rise text-ink-3">
          {deck ? `Nothing new to learn in ${deck}.` : 'Nothing new to learn.'}
        </p>
        <Link href="/" className="text-sm text-ink-3 transition-colors hover:text-ink">
          Home
        </Link>
      </main>
    );
  }

  return (
    <Review
      cards={cards}
      mode="new"
      deck={deck}
      grader={grader}
      explainer={explainer}
      autoAccept={config.graderAutoAccept}
    />
  );
}
