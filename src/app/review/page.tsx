import Link from 'next/link';
import { explainerStatus, graderStatus } from '@/lib/grader';
import { readConfig } from '@/lib/prompt-store';
import { dueCards } from '@/lib/queries';
import { Review } from './review-client';

export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  // Read first because it sets the size of the session: a sitting is a day's cap worth of cards,
  // not everything that happens to be due. Coming back for a second round is a choice made on the
  // home page, where it is labelled honestly, rather than the default.
  const config = await readConfig();

  // Both statuses are asked on every load rather than cached — whether the provider answered when
  // the last page rendered says nothing about whether it will answer now.
  const [cards, grader, explainer] = await Promise.all([
    dueCards(config.dailyReviewCap),
    graderStatus(),
    explainerStatus(),
  ]);

  if (!cards.length) {
    return (
      <main className="safe-b safe-t [--safe-b-base:2.5rem] [--safe-t-base:2.5rem] flex min-h-dvh flex-col items-center justify-center px-6">
        <p className="rise text-ink-3">Nothing due.</p>
        <Link href="/" className="mt-8 text-sm text-ink-3 transition-colors hover:text-ink">
          Home
        </Link>
      </main>
    );
  }

  return (
    <Review
      cards={cards}
      mode="review"
      grader={grader}
      explainer={explainer}
      autoAccept={config.graderAutoAccept}
    />
  );
}
