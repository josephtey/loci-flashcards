'use client';

import Link from 'next/link';
import { HomeButton } from '@/components/home-button';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QuickReview, type Draft } from '@/components/quick-review';
import type { VaultNote } from '@/app/api/vault/route';
import type { QuickCard } from '@/lib/types';

type Status = 'loading' | 'ready' | 'extracting' | 'reviewing' | 'done' | 'error';

function words(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function AddClient() {
  const [notes, setNotes] = useState<VaultNote[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [request, setRequest] = useState('');
  /** 0 means "as many as the material holds" — a quota is usually the wrong default. */
  const [count, setCount] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [skipped, setSkipped] = useState<string | null>(null);
  const [result, setResult] = useState<{ saved: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/vault');
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { notes: VaultNote[] };
      setNotes(data.notes);
      setStatus('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  // A live timer while the single call runs. There is nothing to poll — the request is still
  // open, which is exactly why leaving the page would lose the result.
  useEffect(() => {
    if (status !== 'extracting') return;
    const started = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - started), 250);
    return () => clearInterval(id);
  }, [status]);

  // Cards exist only in memory until saved, so a reload really would throw them away.
  useEffect(() => {
    if (status !== 'extracting' && status !== 'reviewing') return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [status]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter(
      (n) => n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q),
    );
  }, [notes, query]);

  const toggle = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectAllVisible = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = filtered.every((n) => next.has(n.path));
      for (const n of filtered) {
        if (allOn) next.delete(n.path);
        else if (!n.isStub) next.add(n.path);
      }
      return next;
    });
  }, [filtered]);

  const submit = useCallback(async () => {
    if (!selected.size || !request.trim()) return;
    setStatus('extracting');
    setElapsed(0);
    setResult(null);
    setError(null);
    try {
      const res = await fetch('/api/quick-add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          paths: [...selected],
          request: request.trim(),
          count: count || undefined,
        }),
      });
      const d = (await res.json()) as {
        cards?: QuickCard[];
        skipped_reason?: string | null;
        notes?: { path: string; title: string }[];
        error?: string;
      };
      if (!res.ok) throw new Error(d.error ?? 'Extraction failed.');

      // One note is the common case; with several, attribute each card by matching its quoted
      // excerpt back to the note it appears in.
      const paths = [...selected];
      const withNote: Draft[] = (d.cards ?? []).map((c) => ({
        ...c,
        note_path: paths.length === 1 ? paths[0] : (d.notes?.[0]?.path ?? paths[0]),
      }));

      setDrafts(withNote);
      setSkipped(d.skipped_reason ?? null);
      setStatus(withNote.length ? 'reviewing' : 'done');
      if (!withNote.length) setResult({ saved: 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, [selected, request, count]);

  const saveKept = useCallback(
    async (kept: Draft[]) => {
      if (!kept.length) {
        setStatus('done');
        setResult({ saved: 0 });
        setDrafts([]);
        return;
      }
      const res = await fetch('/api/quick-add/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cards: kept }),
      });
      const d = (await res.json()) as { saved?: number; error?: string };
      if (!res.ok) {
        setError(d.error ?? 'Save failed.');
        setStatus('error');
        return;
      }
      setResult({ saved: d.saved ?? kept.length });
      setDrafts([]);
      setStatus('done');
      void load();
    },
    [load],
  );

  const discard = useCallback(() => {
    setDrafts([]);
    setStatus('ready');
  }, []);

  const busy = status === 'extracting' || status === 'reviewing';
  const selectedWords = notes
    .filter((n) => selected.has(n.path))
    .reduce((s, n) => s + n.wordCount, 0);

  if (status === 'extracting') {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6">
        <div className="rise flex flex-col items-center gap-5">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ink-2" />
          <p className="text-sm text-ink-2">
            Reading {selected.size} note{selected.size === 1 ? '' : 's'} for what you asked
          </p>
          <p className="max-w-sm text-center text-xs leading-relaxed text-ink-4">
            &ldquo;{request.trim()}&rdquo;
          </p>
          <p className="font-mono text-[0.6875rem] tabular-nums text-ink-4">
            {Math.floor(elapsed / 60000)}:
            {String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0')}
          </p>
          <p className="mt-4 max-w-xs text-center text-xs leading-relaxed text-ink-4">
            Stay on this page — the cards come back here for you to check, and nothing is saved
            until you do.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="safe-b safe-t mx-auto flex min-h-dvh max-w-3xl flex-col px-5 pb-6 sm:px-8 sm:pb-10 sm:[--safe-t-base:2.5rem]">
      {status === 'reviewing' && drafts.length > 0 && (
        <QuickReview
          cards={drafts}
          skippedReason={skipped}
          onSave={saveKept}
          onCancel={discard}
        />
      )}

      <header className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <HomeButton />
          <h1 className="flex items-center gap-2 text-lg font-light">
            Draft with AI
            <span className="rounded-sm border border-ink-4 px-1 py-px font-mono text-[0.5625rem] uppercase tracking-wider text-ink-4">
              beta
            </span>
          </h1>
          <p className="mt-0.5 text-xs text-ink-3">
            ask for something specific and it pulls only that
          </p>
        </div>

      </header>

      {status === 'loading' && <p className="mt-16 text-sm text-ink-3">Reading the vault…</p>}

      {status === 'error' && (
        <p className="mt-16 text-sm text-ink-2">
          {error}
          <button onClick={() => void load()} className="ml-3 underline underline-offset-4">
            retry
          </button>
        </p>
      )}

      {status === 'done' && (
        <div className="card rise mt-10 px-6 py-5">
          <p className="text-sm text-ink-2">
            {result?.saved
              ? `${result.saved} card${result.saved === 1 ? '' : 's'} added to your deck. `
              : 'Nothing added. '}
            {result?.saved ? (
              <Link href="/new" className="underline underline-offset-4 hover:text-ink">
                See them →
              </Link>
            ) : (
              <span className="text-ink-3">{skipped ?? 'Try a different request.'}</span>
            )}
          </p>
        </div>
      )}

      {status !== 'loading' && status !== 'error' && (
        <>
          <div className="mt-10 flex items-baseline gap-4 border-b border-ink-4 pb-3">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by title or folder…"
              className="flex-1 bg-transparent text-sm placeholder:text-ink-4"
            />
            <button
              onClick={selectAllVisible}
              className="text-[0.6875rem] uppercase tracking-[0.18em] text-ink-3 hover:text-ink"
            >
              toggle all
            </button>
          </div>

          <ul className="mt-2 max-h-[22rem] flex-1 overflow-y-auto overflow-x-hidden">
            {filtered.map((n) => {
              const on = selected.has(n.path);
              return (
                <li key={n.path}>
                  <button
                    onClick={() => !n.isStub && toggle(n.path)}
                    disabled={n.isStub}
                    className={`group flex w-full items-baseline gap-3 py-2.5 text-left transition-opacity sm:py-2 ${
                      n.isStub ? 'cursor-default opacity-25' : ''
                    }`}
                  >
                    <span
                      className={`mt-0.5 inline-block h-3 w-3 shrink-0 rounded-sm border ${
                        on ? 'border-ink bg-ink' : 'border-ink-4 group-hover:border-ink-3'
                      }`}
                    />
                    <span className="flex-1 truncate text-sm text-ink-2 group-hover:text-ink">
                      {n.title}
                    </span>
                    <span className="hidden min-w-0 shrink truncate font-mono text-[0.625rem] tabular-nums text-ink-4 sm:block">
                      {n.subfolder ?? n.folder}
                    </span>
                    <span className="ml-auto w-12 shrink-0 text-right font-mono text-[0.625rem] tabular-nums text-ink-4">
                      {n.isStub ? 'stub' : `${words(n.wordCount)}w`}
                    </span>
                    <span
                      className={`hidden w-14 shrink-0 text-right font-mono text-[0.625rem] tabular-nums xs:block ${
                        n.cards ? 'text-ink-3' : 'text-ink-4'
                      }`}
                      title={`${n.cards} cards, ${n.pending} awaiting triage`}
                    >
                      {n.cards ? `${n.cards} cards` : '—'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="mt-8 border-t border-ink-4 pt-6">
            <label className="mb-2 block text-[0.6875rem] uppercase tracking-[0.18em] text-ink-3">
              What do you want extracted?
            </label>
            <textarea
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              rows={2}
              placeholder="the protocol steps for the stability assay, as cloze"
              className="w-full resize-none bg-transparent leading-relaxed placeholder:text-ink-4"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              {[
                'the protocol steps for the stability assay, as cloze',
                'every numeric threshold and parameter mentioned',
                'the tradeoffs I argued for, not the definitions',
                'the failure modes and what causes each',
              ].map((ex) => (
                <button
                  key={ex}
                  onClick={() => setRequest(ex)}
                  className="rounded-full border border-ink-4 px-3 py-1 text-[0.6875rem] text-ink-3 transition-colors hover:border-ink-3 hover:text-ink-2"
                >
                  {ex}
                </button>
              ))}
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <label className="text-[0.6875rem] uppercase tracking-[0.18em] text-ink-3">
                How many
              </label>
              <input
                type="range"
                min={0}
                max={30}
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="h-1 flex-1 min-w-40 cursor-pointer appearance-none rounded-full bg-ink-4 accent-ink"
              />
              <span className="w-20 shrink-0 font-mono text-[0.6875rem] tabular-nums text-ink-2 sm:w-24">
                {count === 0 ? 'as it holds' : `~${count} card${count === 1 ? '' : 's'}`}
              </span>
            </div>

            <p className="mt-3 text-xs text-ink-4">
              It extracts only this — not a general sweep. Name a form (cloze, definitions) and it
              writes to it. A number is a target, not a quota: it won&apos;t pad to reach it, and
              if the note doesn&apos;t contain what you asked for it says so rather than
              substituting something near it.
            </p>
          </div>

          <footer className="mt-6 flex flex-wrap items-center gap-4 border-t border-ink-4 pt-5">
            <button
              onClick={() => void submit()}
              disabled={!selected.size || !request.trim() || busy}
              className="rounded border border-ink-4 px-4 py-2 text-sm text-ink-2 transition-colors hover:border-ink-2 hover:text-ink disabled:opacity-30 disabled:hover:border-ink-4"
            >
              {!request.trim()
                ? 'Describe what to extract'
                : `Extract from ${selected.size || 'no'} note${selected.size === 1 ? '' : 's'}`}
            </button>
            {selected.size > 0 && request.trim() && (
              <span className="text-xs text-ink-3">
                searching ~{words(selectedWords)} words
                {count > 0 ? ` for about ${count}` : ''}
              </span>
            )}
          </footer>
        </>
      )}
    </main>
  );
}
