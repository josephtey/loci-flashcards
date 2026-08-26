import Link from 'next/link';
import { explainerStatus, graderStatus } from '@/lib/grader';
import { readConfig } from '@/lib/prompt-store';
import { dueCards } from '@/lib/queries';
import { Review } from './review-client';

export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  // Asked on every load rather than cached: Ollama is a process on a laptop, and whether it was
  // running when the last page rendered says nothing about whether it is running now.
  const [cards, grader, explainer, config] = await Promise.all([
    dueCards(),
    graderStatus(),
    explainerStatus(),
    readConfig(),
  ]);

  if (!cards.length) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center px-6">
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
