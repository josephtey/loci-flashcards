'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SyncModal } from '@/components/sync-modal';

interface ScanStatus {
  running: boolean;
  elapsedMs: number | null;
  current: { scope: string | null; request: string | null } | null;
}

/**
 * The sync button, and — when there is one — the sync that's already running.
 *
 * A scan is a detached process that can outlive the page that started it, costs real money per
 * minute, and is otherwise completely invisible. So the home page always says whether one is in
 * flight and always offers the stop button, rather than making you go looking for a process.
 */
export function HomeSync({
  available,
  reason,
}: {
  available: boolean;
  reason: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [cancelling, setCancelling] = useState(false);

  const check = useCallback(async () => {
    if (!available) return;
    const s = await fetch('/api/scan')
      .then((r) => r.json() as Promise<ScanStatus>)
      .catch(() => null);
    if (s) {
      setStatus(s);
      setElapsed(s.elapsedMs ?? 0);
    }
  }, [available]);

  useEffect(() => {
    const first = setTimeout(check, 0);
    const poll = setInterval(check, 10000);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
    };
  }, [check]);

  // Between polls the clock still has to move, or a live run looks frozen.
  useEffect(() => {
    if (!status?.running) return;
    const tick = setInterval(() => setElapsed((e) => e + 1000), 1000);
    return () => clearInterval(tick);
  }, [status?.running]);

  const cancel = useCallback(async () => {
    setCancelling(true);
    try {
      await fetch('/api/scan', { method: 'DELETE' });
      await check();
      router.refresh();
    } finally {
      setCancelling(false);
    }
  }, [check, router]);

  const running = status?.running ?? false;

  // Hosted, there is no vault to read and nothing to spawn a scanner with. The button stays
  // visible so the feature is discoverable, but it says why it can't run rather than failing
  // three fetches deep.
  if (!available) {
    return (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          aria-disabled="true"
          title={reason ?? undefined}
          className="cursor-not-allowed rounded border border-ink-4/50 px-4 py-2 text-sm text-ink-4"
        >
          ↻ Sync with Obsidian
        </span>
        <span className="max-w-xs text-[0.6875rem] leading-relaxed text-ink-4">
          needs the vault — run locally to generate cards
        </span>
      </span>
    );
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded border border-ink-4 px-4 py-2 text-sm text-ink-2 transition-colors hover:border-ink-2 hover:text-ink"
      >
        ↻ Sync with Obsidian
      </button>

      {running && (
        <span className="flex items-center gap-3 text-xs">
          <span className="flex items-center gap-2 text-mem-short">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-mem-short" />
            syncing
            <span className="font-mono tabular-nums text-ink-4">
              {Math.floor(elapsed / 60000)}:
              {String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0')}
            </span>
            {status?.current?.scope && (
              <span className="text-ink-4">· {status.current.scope}</span>
            )}
          </span>
          <button
            onClick={() => void cancel()}
            disabled={cancelling}
            className="text-ink-4 underline-offset-4 transition-colors hover:text-mem-fresh hover:underline disabled:opacity-40"
          >
            {cancelling ? 'stopping…' : 'cancel'}
          </button>
        </span>
      )}

      {open && (
        <SyncModal
          onClose={() => {
            setOpen(false);
            void check();
            router.refresh();
          }}
        />
      )}
    </>
  );
}
