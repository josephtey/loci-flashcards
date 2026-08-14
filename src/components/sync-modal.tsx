'use client';

import { useCallback, useEffect, useState } from 'react';
import { renderCloze } from '@/lib/cloze';

interface Change {
  path: string;
  title: string;
  folder: string;
  kind: 'new' | 'changed';
  blocks: number;
  words: number;
  diff: string;
}

interface ResultCard {
  id: string;
  front: string;
  back: string | null;
  cloze_text: string | null;
  type: string;
  angle: string;
}

interface ResultNote {
  title: string;
  folder: string;
  cards: ResultCard[];
}

interface Folder {
  name: string;
  path: string;
  notes: number;
  subfolders: number;
}

interface RunNote {
  note_title: string;
  note_path: string;
  kind: 'new' | 'changed';
  diff_text: string;
  words: number;
  targets_created: number;
  cards_created: number;
  skipped_reason: string | null;
}

interface Run {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  scope: string | null;
  request: string | null;
  targets_proposed: number;
  cards_proposed: number;
  model: string | null;
  error: string | null;
  notes: RunNote[];
}

type Phase = 'loading' | 'diffs' | 'running' | 'results' | 'error';

/** The folders to start on. Everything else in the vault is opt-in, one chip at a time. */
const DEFAULT_FOLDERS = ['Biotech + Pharma', 'Biology'];

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * The sync flow, end to end, in one place.
 *
 * Three steps, because the interesting question changes as you go: first *what changed in the
 * vault*, then *is it still working*, then *what did it make of it*. Splitting those across pages
 * would lose the thread — the whole value is seeing the diff and the cards it produced next to
 * each other.
 *
 * The history tab is the same idea stretched over time: every past run keeps the diff text it
 * read, so a batch of weak cards can be traced back to the edit that produced it.
 */
export function SyncModal({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [tab, setTab] = useState<'changes' | 'history'>('changes');
  const [changes, setChanges] = useState<Change[]>([]);
  const [meta, setMeta] = useState({ scanned: 0, unchanged: 0, skipped: 0 });
  const [folders, setFolders] = useState<Folder[]>([]);
  const [scope, setScope] = useState<string[]>(DEFAULT_FOLDERS);
  const [open, setOpen] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [notes, setNotes] = useState<ResultNote[]>([]);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [openRunNote, setOpenRunNote] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDiffs = useCallback(async (only: string[]) => {
    setPhase('loading');
    try {
      const qs = only.map((f) => `only=${encodeURIComponent(f)}`).join('&');
      const res = await fetch(`/api/sync/preview${qs ? `?${qs}` : ''}`);
      if (!res.ok) throw new Error(await res.text());
      const d = (await res.json()) as { changes: Change[] } & typeof meta;
      setChanges(d.changes);
      setMeta({ scanned: d.scanned, unchanged: d.unchanged, skipped: d.skipped });
      setPhase('diffs');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, []);

  // A scan already in flight — started here before a reload, or from the terminal — is adopted
  // rather than ignored, so there is never a hidden job you can't see or stop.
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      const running = await fetch('/api/scan')
        .then((r) => r.json() as Promise<{ running: boolean; elapsedMs: number | null }>)
        .catch(() => null);
      if (!live) return;
      if (running?.running) {
        setElapsed(running.elapsedMs ?? 0);
        setPhase('running');
        return;
      }
      void loadDiffs(DEFAULT_FOLDERS);
    }, 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [loadDiffs]);

  useEffect(() => {
    let live = true;
    fetch('/api/vault/folders')
      .then((r) => r.json() as Promise<{ folders: Folder[] }>)
      .then((d) => live && setFolders(d.folders ?? []))
      .catch(() => {
        /* the filter degrades to whatever is already selected */
      });
    return () => {
      live = false;
    };
  }, []);

  const loadHistory = useCallback(async () => {
    const d = await fetch('/api/sync/log')
      .then((r) => r.json() as Promise<{ runs: Run[] }>)
      .catch(() => ({ runs: [] }));
    setRuns(d.runs ?? []);
  }, []);

  // Running: tick a clock and watch for the scan to finish.
  useEffect(() => {
    if (phase !== 'running') return;
    const started = Date.now() - elapsed;
    const tick = setInterval(() => setElapsed(Date.now() - started), 500);
    const poll = setInterval(async () => {
      try {
        const res = await fetch('/api/scan');
        const s = (await res.json()) as { running: boolean };
        if (!s.running && Date.now() - started > 6000) {
          const r = await fetch('/api/sync/result');
          const d = (await r.json()) as { notes: ResultNote[] };
          setNotes(d.notes);
          setRuns(null); // history has a new entry in it now
          setPhase('results');
        }
      } catch {
        /* a dev-server reload mid-scan is not worth surfacing */
      }
    }, 4000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
    // `elapsed` seeds the clock when an in-flight run is adopted; re-running on every tick would
    // reset it, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // The scan writes as it goes, so leaving is not destructive — but it is the only place the
  // summary is shown, so warn before it disappears.
  useEffect(() => {
    if (phase !== 'running') return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  const generate = useCallback(async () => {
    setPhase('running');
    setElapsed(0);
    await fetch('/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ only: scope }),
    });
  }, [scope]);

  const cancel = useCallback(async () => {
    setCancelling(true);
    try {
      await fetch('/api/scan', { method: 'DELETE' });
      const r = await fetch('/api/sync/result');
      const d = (await r.json()) as { notes: ResultNote[] };
      setNotes(d.notes);
      setRuns(null);
      setPhase('results');
    } finally {
      setCancelling(false);
    }
  }, []);

  const toggleFolder = useCallback(
    (name: string) => {
      const next = scope.includes(name) ? scope.filter((f) => f !== name) : [...scope, name];
      setScope(next);
      setOpen(null);
      void loadDiffs(next);
    },
    [scope, loadDiffs],
  );

  const totalCards = notes.reduce((s, n) => s + n.cards.length, 0);
  const totalWords = changes.reduce((s, c) => s + c.words, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/95 px-4 py-6 backdrop-blur-sm sm:px-6 sm:py-10">
      <div className="rise flex h-full w-full max-w-3xl flex-col">
        {/* ── header ─────────────────────────────────────────────────────── */}
        <div className="flex shrink-0 items-baseline justify-between gap-4">
          <div>
            <h2 className="text-lg font-light">
              {phase === 'results' ? 'Cards added' : 'Sync with Obsidian'}
            </h2>
            <p className="mt-1 text-xs text-ink-3">
              {phase === 'loading' && 'Reading the vault…'}
              {phase === 'diffs' &&
                tab === 'changes' &&
                (changes.length
                  ? `${changes.length} note${changes.length === 1 ? '' : 's'} changed · ~${totalWords.toLocaleString()} words · ${meta.unchanged} untouched`
                  : `Nothing has changed. ${meta.scanned} notes checked.`)}
              {phase === 'diffs' && tab === 'history' && 'Every run, and what it read'}
              {phase === 'running' && 'Reading each change and writing cards'}
              {phase === 'results' &&
                (totalCards
                  ? `${totalCards} card${totalCards === 1 ? '' : 's'} across ${notes.length} note${notes.length === 1 ? '' : 's'}`
                  : 'No cards this time')}
            </p>
          </div>
          {phase !== 'running' && (
            <button onClick={onClose} className="text-sm text-ink-3 hover:text-ink">
              {phase === 'results' ? 'Done' : 'Close'}
            </button>
          )}
        </div>

        {/* ── scope + tabs ───────────────────────────────────────────────── */}
        {(phase === 'diffs' || phase === 'loading') && (
          <div className="mt-4 flex shrink-0 flex-wrap items-center gap-x-2 gap-y-2">
            <span className="mr-1 font-mono text-[0.5625rem] uppercase tracking-wider text-ink-4">
              Ever Green Learnings /
            </span>
            {folders.map((f) => {
              const on = scope.includes(f.name);
              return (
                <button
                  key={f.path}
                  onClick={() => toggleFolder(f.name)}
                  className={`rounded-full border px-2.5 py-1 text-[0.6875rem] transition-colors ${
                    on
                      ? 'border-ink-2/60 bg-white/[0.06] text-ink'
                      : 'border-ink-4 text-ink-4 hover:border-ink-3 hover:text-ink-2'
                  }`}
                >
                  {f.name}
                </button>
              );
            })}
            {!scope.length && (
              <span className="text-[0.6875rem] text-ink-4">everything in the folder</span>
            )}
            <div className="ml-auto flex items-center gap-3 text-[0.6875rem]">
              {(['changes', 'history'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    setTab(t);
                    if (t === 'history' && runs === null) void loadHistory();
                  }}
                  className={tab === t ? 'text-ink' : 'text-ink-4 hover:text-ink-2'}
                >
                  {t === 'changes' ? 'Changes' : 'History'}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── body ───────────────────────────────────────────────────────── */}
        <div className="card-quiet mt-4 min-h-0 flex-1 overflow-y-auto">
          {phase === 'error' && <p className="p-6 text-sm text-ink-2">{error}</p>}

          {phase === 'loading' && (
            <p className="p-6 text-sm text-ink-3">Comparing the vault against the last scan…</p>
          )}

          {phase === 'running' && (
            <div className="flex h-full flex-col items-center justify-center gap-5 p-10">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ink-2" />
              <p className="text-sm text-ink-2">
                {changes.length
                  ? `Working through ${changes.length} note${changes.length === 1 ? '' : 's'}`
                  : 'A sync is already running'}
              </p>
              <p className="font-mono text-[0.6875rem] tabular-nums text-ink-4">
                {Math.floor(elapsed / 60000)}:
                {String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0')}
              </p>
              <p className="max-w-xs text-center text-xs leading-relaxed text-ink-4">
                This takes a few minutes per note. Stay here — the summary of what was made only
                appears once, right here.
              </p>
              <button
                onClick={() => void cancel()}
                disabled={cancelling}
                className="mt-2 rounded border border-ink-4 px-3 py-1.5 text-xs text-ink-3 transition-colors hover:border-mem-fresh hover:text-mem-fresh disabled:opacity-40"
              >
                {cancelling ? 'Stopping…' : 'Cancel this run'}
              </button>
              <p className="max-w-xs text-center text-[0.625rem] leading-relaxed text-ink-4">
                Cards already written stay in your deck. Notes not reached yet stay unread, so the
                next sync picks them up.
              </p>
            </div>
          )}

          {/* Diffs, accordion. */}
          {phase === 'diffs' &&
            tab === 'changes' &&
            changes.map((c) => {
              const isOpen = open === c.path;
              return (
                <div key={c.path} className="border-b border-ink-4/50 last:border-0">
                  <button
                    onClick={() => setOpen(isOpen ? null : c.path)}
                    className="group flex w-full items-baseline gap-2 px-4 py-3 text-left hover:bg-white/[0.02] active:bg-white/[0.04] sm:gap-3 sm:px-5"
                  >
                    <span className="font-mono text-[0.625rem] text-ink-4">
                      {isOpen ? '−' : '+'}
                    </span>
                    <span className="min-w-0 truncate text-sm text-ink-2 group-hover:text-ink">{c.title}</span>
                    <span className="hidden flex-1 truncate font-mono text-[0.625rem] text-ink-4 sm:block">
                      {c.folder}
                    </span>
                    <span
                      className={`font-mono text-[0.625rem] ${c.kind === 'new' ? 'text-mem-long' : 'text-mem-short'}`}
                    >
                      {c.kind}
                    </span>
                    <span className="ml-auto w-16 shrink-0 text-right font-mono text-[0.625rem] tabular-nums text-ink-4 sm:w-20">
                      {c.blocks ? c.words : '—'}
                      <span className="hidden sm:inline">{c.blocks ? ' words' : ' removals only'}</span>
                    </span>
                  </button>
                  {isOpen && (
                    <pre className="rise overflow-x-auto whitespace-pre-wrap px-4 pb-4 pl-8 font-mono text-[0.6875rem] leading-relaxed text-ink-3 sm:px-5 sm:pl-11">
                      {c.diff || '(no textual diff — new file)'}
                    </pre>
                  )}
                </div>
              );
            })}

          {phase === 'diffs' && tab === 'changes' && !changes.length && (
            <p className="p-6 text-sm text-ink-3">
              Nothing to generate from{scope.length ? ` in ${scope.join(', ')}` : ''}. Write
              something, or widen the filter.
            </p>
          )}

          {/* History: runs, each opening onto the notes it read. */}
          {phase === 'diffs' && tab === 'history' && runs === null && (
            <p className="p-6 text-sm text-ink-3">Loading past runs…</p>
          )}

          {phase === 'diffs' && tab === 'history' && runs?.length === 0 && (
            <p className="p-6 text-sm text-ink-3">No runs recorded yet.</p>
          )}

          {phase === 'diffs' &&
            tab === 'history' &&
            (runs ?? []).map((r) => {
              const isOpen = openRun === r.id;
              return (
                <div key={r.id} className="border-b border-ink-4/50 last:border-0">
                  <button
                    onClick={() => setOpenRun(isOpen ? null : r.id)}
                    className="group flex w-full items-baseline gap-2 px-4 py-3 text-left hover:bg-white/[0.02] active:bg-white/[0.04] sm:gap-3 sm:px-5"
                  >
                    <span className="font-mono text-[0.625rem] text-ink-4">
                      {isOpen ? '−' : '+'}
                    </span>
                    <span className="w-20 shrink-0 text-sm text-ink-2 group-hover:text-ink">
                      {ago(r.started_at)}
                    </span>
                    <span className="hidden min-w-0 flex-1 truncate font-mono text-[0.625rem] text-ink-4 sm:block">
                      {r.request ? `“${r.request}”` : (r.scope ?? 'whole vault')}
                    </span>
                    <span
                      className={`font-mono text-[0.625rem] ${
                        r.status === 'completed'
                          ? 'text-ink-4'
                          : r.status === 'running'
                            ? 'text-mem-short'
                            : 'text-mem-fresh'
                      }`}
                    >
                      {r.status === 'completed' ? '' : r.status}
                    </span>
                    <span className="ml-auto w-16 shrink-0 text-right font-mono text-[0.625rem] tabular-nums text-ink-4 sm:w-24">
                      {r.cards_proposed} card{r.cards_proposed === 1 ? '' : 's'}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="rise pb-3 pl-8 pr-4 sm:pl-11 sm:pr-5">
                      {r.error && <p className="pb-2 text-xs text-mem-fresh">{r.error}</p>}
                      {!r.notes.length && (
                        <p className="pb-2 text-xs text-ink-4">
                          No per-note log for this run — it predates the log, or nothing was read.
                        </p>
                      )}
                      {r.notes.map((n) => {
                        const key = `${r.id}:${n.note_path}`;
                        const noteOpen = openRunNote === key;
                        return (
                          <div key={key}>
                            <button
                              onClick={() => setOpenRunNote(noteOpen ? null : key)}
                              className="flex w-full items-baseline gap-3 py-1.5 text-left"
                            >
                              <span className="text-xs text-ink-3 hover:text-ink">
                                {n.note_title}
                              </span>
                              <span className="flex-1 truncate font-mono text-[0.5625rem] text-ink-4">
                                {n.skipped_reason ?? `${n.words} words in`}
                              </span>
                              <span className="font-mono text-[0.5625rem] tabular-nums text-ink-4">
                                {n.cards_created} card{n.cards_created === 1 ? '' : 's'}
                              </span>
                            </button>
                            {noteOpen && (
                              <pre className="rise mb-2 overflow-x-auto whitespace-pre-wrap border-l border-ink-4 pl-3 font-mono text-[0.625rem] leading-relaxed text-ink-4">
                                {n.diff_text || '(no diff recorded)'}
                              </pre>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

          {/* Results: one glance per card, grouped by note. */}
          {phase === 'results' &&
            notes.map((n) => (
              <div key={n.title} className="border-b border-ink-4/50 last:border-0">
                <div className="sticky top-0 z-10 flex items-baseline gap-3 bg-[#101013]/95 px-4 py-2.5 backdrop-blur sm:px-5">
                  <span className="text-xs text-ink-2">{n.title}</span>
                  <span className="flex-1 truncate font-mono text-[0.625rem] text-ink-4">
                    {n.folder}
                  </span>
                  <span className="font-mono text-[0.625rem] tabular-nums text-ink-4">
                    {n.cards.length}
                  </span>
                </div>
                <ul className="space-y-3 p-4 sm:p-5">
                  {n.cards.map((c) => {
                    const q =
                      c.cloze_text && c.type === 'cloze'
                        ? renderCloze(c.cloze_text, false)
                        : c.front;
                    const a =
                      c.cloze_text && c.type === 'cloze' ? renderCloze(c.cloze_text, true) : c.back;
                    return (
                      <li key={c.id} className="card px-4 py-3">
                        <p className="text-sm leading-snug text-ink">{q}</p>
                        {a && <p className="mt-1.5 text-sm leading-snug text-ink-3">{a}</p>}
                        <p className="mt-2 font-mono text-[0.5625rem] uppercase tracking-wider text-ink-4">
                          {c.angle}
                          {c.type !== 'qa' && ` · ${c.type}`}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}

          {phase === 'results' && !notes.length && (
            <p className="p-6 text-sm text-ink-3">
              The scan finished without producing cards. Check the methodology page if that keeps
              happening.
            </p>
          )}
        </div>

        {/* ── footer ─────────────────────────────────────────────────────── */}
        <div className="mt-5 flex shrink-0 items-center gap-6 text-xs text-ink-3">
          {phase === 'diffs' && tab === 'changes' && changes.length > 0 && (
            <>
              <button
                onClick={() => void generate()}
                className="rounded border border-ink-4 px-4 py-2 text-sm text-ink-2 transition-colors hover:border-ink-2 hover:text-ink"
              >
                Generate cards
              </button>
              <span className="text-ink-4">
                roughly {Math.max(1, Math.round(totalWords / 110))} cards · a few minutes per note
              </span>
            </>
          )}
          {phase === 'results' && (
            <a
              href="/new"
              className="rounded border border-ink-4 px-4 py-2 text-sm text-ink-2 hover:border-ink-2 hover:text-ink"
            >
              Start learning →
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
