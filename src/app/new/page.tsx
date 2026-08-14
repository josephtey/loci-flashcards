import Link from 'next/link';
import { newCards } from '@/lib/queries';
import { Review } from '../review/review-client';

export const dynamic = 'force-dynamic';

export default async function NewPage() {
  const cards = await newCards();

  if (!cards.length) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6">
        <p className="rise text-ink-3">Nothing new to learn.</p>
        <Link href="/" className="text-sm text-ink-3 transition-colors hover:text-ink">
          Home
        </Link>
      </main>
    );
  }

  return <Review cards={cards} mode="new" />;
}
