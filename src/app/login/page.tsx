import { redirect } from 'next/navigation';
import { passwordConfigured } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  // Nothing to log in to when running locally without a password.
  if (!passwordConfigured()) redirect('/');

  const { next = '/', error } = await searchParams;

  return (
    <main className="safe-b safe-t [--safe-b-base:2.5rem] [--safe-t-base:2.5rem] flex min-h-dvh flex-col items-center justify-center px-6">
      <form method="post" action="/api/login" className="rise flex w-full max-w-xs flex-col gap-4">
        <input type="hidden" name="next" value={next} />
        <label className="flex flex-col gap-2">
          <span className="text-sm text-ink-3">Password</span>
          <input
            name="password"
            type="password"
            autoFocus
            autoComplete="current-password"
            className="rounded border border-ink-4 bg-surface px-3 py-2 text-ink outline-none focus:border-ink-3"
          />
        </label>
        {error && <p className="text-sm text-mem-fresh">That isn&apos;t it.</p>}
        <button
          type="submit"
          className="rounded border border-ink-4 px-3 py-2 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
        >
          Enter
        </button>
      </form>
    </main>
  );
}
