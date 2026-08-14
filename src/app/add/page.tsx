import { HomeButton } from '@/components/home-button';
import { vaultStatus } from '@/lib/environment';
import { AddClient } from './add-client';

export const dynamic = 'force-dynamic';

export default async function AddPage() {
  // Drafting reads the markdown itself, so without the vault there is nothing to pick from.
  // Better to say so here than to let the note picker spin and fail.
  const vault = await vaultStatus();
  if (!vault.available) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-16 sm:px-8">
        <HomeButton />
        <h1 className="text-lg font-light">Draft with AI</h1>
        <p className="mt-4 text-sm leading-relaxed text-ink-3">{vault.reason}</p>
        <p className="mt-6 text-sm text-ink-4">
          Writing a card by hand works anywhere —{' '}
          <a href="/cards" className="text-ink-3 underline-offset-4 hover:text-ink hover:underline">
            go to Cards
          </a>
          .
        </p>
      </main>
    );
  }

  // The note list is fetched client-side: it reads the filesystem, so it's slow enough to want a
  // loading state, and the picker needs to re-fetch after a run to show updated card counts.
  return <AddClient />;
}
