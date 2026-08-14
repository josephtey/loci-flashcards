import Link from 'next/link';
import { dueCards } from '@/lib/queries';
import { Review } from './review-client';

export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  const cards = await dueCards();

  if (!cards.length) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center px-8">
        <p className="rise text-ink-3">Nothing due.</p>
        <Link href="/" className="mt-8 text-sm text-ink-3 transition-colors hover:text-ink">
          Home
        </Link>
      </main>
    );
  }

  return <Review cards={cards} mode="review" />;
}
