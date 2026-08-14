'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface ScanStatus {
  running: boolean;
  elapsedMs: number | null;
  lastRun: {
    status: string;
    notes_changed: number;
    notes_new: number;
    cards_proposed: number;
    error: string | null;
  } | null;
  pendingTargets: number;
}

/**
 * Kick off a vault scan and watch it.
 *
 * A scan takes minutes, so this fires and polls rather than blocking. It only works when the
 * app and the vault are on the same machine — the scanner reads the filesystem directly.
 */
export function SyncButton({ onDone }: { onDone?: () => void }) {
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const wasRunning = useRef(false);

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/scan');
      if (!res.ok) return;
      const next = (await res.json()) as ScanStatus;
      setStatus(next);

      // Only refresh the page once, on the running → idle edge.
      if (wasRunning.current && !next.running) {
        wasRunning.current = false;
        onDone?.();
      }
      if (next.running) wasRunning.current = true;
    } catch {
      /* the dev server restarting mid-scan is not worth surfacing */
    }
  }, [onDone]);

  // One effect owns polling. The first tick fires on a timer rather than synchronously, so the
  // effect body never calls setState directly; the cadence then depends on whether a scan is up.
  useEffect(() => {
    const active = status?.running || starting;
    const first = setTimeout(poll, 0);
    const repeat = active ? setInterval(poll, 4000) : null;
    return () => {
      clearTimeout(first);
      if (repeat) clearInterval(repeat);
    };
  }, [status?.running, starting, poll]);

  const start = useCallback(async () => {
    setStarting(true);
    try {
      await fetch('/api/scan', { method: 'POST' });
      wasRunning.current = true;
      await poll();
    } finally {
      setStarting(false);
    }
  }, [poll]);

  const running = status?.running || starting;

  if (running) {
    const mins = status?.elapsedMs ? Math.floor(status.elapsedMs / 60000) : 0;
    const secs = status?.elapsedMs ? Math.floor((status.elapsedMs % 60000) / 1000) : 0;
    return (
      <span className="flex items-center gap-2 text-sm text-ink-3">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ink-2" />
        Scanning
        {status?.elapsedMs != null && (
          <span className="font-mono text-[0.6875rem] tabular-nums text-ink-4">
            {mins}:{String(secs).padStart(2, '0')}
          </span>
        )}
      </span>
    );
  }

  return (
    <button
      onClick={() => void start()}
      title="Read the vault, extract from anything that changed"
      className="text-sm text-ink-3 transition-colors hover:text-ink"
    >
      ↻ Sync vault
    </button>
  );
}
