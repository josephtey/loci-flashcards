'use client';

import Link from 'next/link';
import { HomeButton } from '@/components/home-button';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { renderCloze } from '@/lib/cloze';
import type { BrowseCard, BrowseNote } from '@/lib/queries';
import { ANGLES, CARD_TYPES, type Angle, type CardType } from '@/lib/types';

/**
 * Memory strength, in four tiers.
 *
 * FSRS tracks `stability` — the number of days until recall probability decays to ~90%. That is
 * the honest measure of how well something is held, and far more informative than "how many
 * times have I seen it": a card reviewed ten times at short intervals is weaker than one seen
 * three times across a year. The thresholds are the ones the intervals naturally cluster around.
 */
const TIERS = {
  new: { label: 'new', color: 'text-mem-new', dot: 'bg-mem-new' },
  fresh: { label: 'fresh', color: 'text-mem-fresh', dot: 'bg-mem-fresh' },
  short: { label: 'short-term', color: 'text-mem-short', dot: 'bg-mem-short' },
  medium: { label: 'medium-term', color: 'text-mem-medium', dot: 'bg-mem-medium' },
  long: { label: 'long-term', color: 'text-mem-long', dot: 'bg-mem-long' },
  dropped: { label: 'dropped', color: 'text-mem-dropped', dot: 'bg-mem-dropped' },
} as const;

type TierKey = keyof typeof TIERS;

function tierOf(c: BrowseCard): TierKey {
  if (c.status === 'retired') return 'dropped';
  if (c.reps === 0) return 'new';
  const s = c.stability ?? 0;
  if (s < 7) return 'fresh';
  if (s < 30) return 'short';
  if (s < 180) return 'medium';
  return 'long';
}

function when(iso: string | null): string {
  if (!iso) return '—';
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days < -1) return `${-days}d ago`;
  if (days <= 0) return 'now';
  if (days === 1) return '1d';
  if (days < 60) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export function CardsClient({
  notes,
  vaultAvailable,
}: {
  notes: BrowseNote[];
  vaultAvailable: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [tierFilter, setTierFilter] = useState<TierKey | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  /**
   * One modal serves both writing a card and fixing one — they are the same form over the same
   * fields, and splitting them would mean two places to keep in step.
   */
  const [modal, setModal] = useState<
    | { mode: 'create'; note: BrowseNote | null }
    | { mode: 'edit'; card: BrowseCard; note: BrowseNote | null }
    | null
  >(null);
  const [draft, setDraft] = useState({
    front: '',
    back: '',
    angle: 'fact' as Angle,
    type: 'qa' as CardType,
  });
  /** The card awaiting a yes/no on deletion. Deleting is the one action here with no undo. */
  const [pendingDelete, setPendingDelete] = useState<BrowseCard | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return notes
      .map((n) => ({
        ...n,
        cards: n.cards.filter((c) => {
          if (tierFilter && tierOf(c) !== tierFilter) return false;
          if (!tierFilter && c.status === 'retired') return false;
          if (!q) return true;
          return (
            c.front.toLowerCase().includes(q) ||
            (c.back ?? '').toLowerCase().includes(q) ||
            n.title.toLowerCase().includes(q)
          );
        }),
      }))
      .filter((n) => n.cards.length > 0);
  }, [notes, query, tierFilter]);

  const total = filtered.reduce((s, n) => s + n.cards.length, 0);

  const counts = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const n of notes) for (const c of n.cards) acc[tierOf(c)] = (acc[tierOf(c)] ?? 0) + 1;
    return acc;
  }, [notes]);

  const openCreate = useCallback((note: BrowseNote | null) => {
    setDraft({ front: '', back: '', angle: 'fact', type: 'qa' });
    setModal({ mode: 'create', note });
  }, []);

  const openEdit = useCallback((card: BrowseCard, note: BrowseNote | null) => {
    setDraft({
      front: card.front,
      back: card.back ?? '',
      angle: card.angle,
      type: card.type,
    });
    setModal({ mode: 'edit', card, note });
  }, []);

  const save = useCallback(async () => {
    if (!modal || !draft.front.trim()) return;
    setBusy(true);
    try {
      if (modal.mode === 'edit') {
        await fetch(`/api/cards/${modal.card.id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'edit',
            front: draft.front.trim(),
            back: draft.back.trim() || null,
          }),
        });
      } else {
        await fetch('/api/cards', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            // No note means a standalone card — something worth remembering that did not come
            // from the vault at all.
            note_path: modal.note?.path,
            front: draft.front.trim(),
            back: draft.back.trim() || null,
            angle: draft.angle,
            type: draft.type,
          }),
        });
      }
      setModal(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }, [modal, draft, router]);

  const remove = useCallback(async () => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await fetch(`/api/cards/${pendingDelete.id}`, { method: 'DELETE' });
      setPendingDelete(null);
      setModal(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }, [pendingDelete, router]);

  // Enter confirms, Escape backs out — the same two keys the browser's own dialog answers to,
  // so the muscle memory carries over even though the chrome doesn't.
  useEffect(() => {
    if (!pendingDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setPendingDelete(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        void remove();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingDelete, remove]);



  return (
    <main className="safe-b safe-t mx-auto flex h-dvh max-w-5xl flex-col px-5 [--safe-b-base:2rem] sm:px-8 sm:[--safe-t-base:2rem]">
      <header className="flex shrink-0 flex-wrap items-baseline justify-between gap-4">
        <div>
          <HomeButton />
          <h1 className="text-lg font-light">Cards</h1>
          <p className="mt-0.5 text-xs text-ink-3 tabular-nums">
            {total} across {filtered.length} note{filtered.length === 1 ? '' : 's'}
          </p>
        </div>
        {/* Two ways to add, kept visibly distinct: one you write, one the model drafts. */}
        <div className="flex items-center gap-3 text-sm">
          <button
            onClick={() => openCreate(null)}
            className="rounded border border-ink-4 px-3 py-1.5 text-ink-2 transition-colors hover:border-ink-2 hover:text-ink"
          >
            Write a card
          </button>
          <Link
            href="/add"
            aria-disabled={!vaultAvailable}
            title={vaultAvailable ? undefined : 'Needs the Obsidian vault — run locally'}
            className={`flex items-center gap-2 rounded border px-3 py-1.5 transition-colors ${
              vaultAvailable
                ? 'border-ink-4 text-ink-3 hover:border-ink-2 hover:text-ink'
                : 'pointer-events-none border-ink-4/50 text-ink-4'
            }`}
          >
            Draft with AI
            <span className="rounded-sm border border-ink-4 px-1 py-px font-mono text-[0.5625rem] uppercase tracking-wider text-ink-4">
              beta
            </span>
          </Link>
        </div>
      </header>

      {/* Filters. The tier chips double as a distribution readout. */}
      <div className="mt-6 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          className="min-w-40 flex-1 border-b border-ink-4 bg-transparent pb-1.5 text-sm placeholder:text-ink-4"
        />
        {(Object.keys(TIERS) as TierKey[]).map((k) => {
          const on = tierFilter === k;
          return (
            <button
              key={k}
              onClick={() => setTierFilter(on ? null : k)}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 sm:py-1 text-[0.6875rem] transition-colors ${
                on ? 'border-ink-2 text-ink' : 'border-ink-4 text-ink-3 hover:text-ink-2'
              }`}
            >
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${TIERS[k].dot}`} />
              {TIERS[k].label}
              <span className="tabular-nums text-ink-4">{counts[k] ?? 0}</span>
            </button>
          );
        })}
      </div>

      {/* The table. Scrolls inside itself; the page does not move. */}
      <div className="card-quiet mt-5 min-h-0 flex-1 overflow-hidden">
        <div className="flex items-baseline gap-3 border-b border-ink-4 bg-surface px-4 py-2 font-mono text-[0.625rem] uppercase tracking-wider text-ink-4">
          <span className="w-24 shrink-0">memory</span>
          <span className="flex-1">card</span>
          <span className="hidden w-28 shrink-0 sm:block">angle</span>
          <span className="w-14 shrink-0 text-right">due</span>
          <span className="w-10 shrink-0" />
        </div>

        <div className="h-[calc(100%-2.25rem)] overflow-y-auto">
          {filtered.map((note) => {
            const open = !collapsed.has(note.id);
            return (
              <section key={note.id}>
                <div className="sticky top-0 z-10 flex items-baseline gap-3 border-b border-ink-4/60 bg-bg/95 px-4 py-2 backdrop-blur">
                  <button
                    onClick={() =>
                      setCollapsed((s) => {
                        const n = new Set(s);
                        if (n.has(note.id)) n.delete(note.id);
                        else n.add(note.id);
                        return n;
                      })
                    }
                    className="group flex flex-1 items-baseline gap-2 py-1.5 text-left sm:py-0"
                  >
                    <span className="font-mono text-[0.625rem] text-ink-4">{open ? '−' : '+'}</span>
                    <span className="text-xs text-ink-2 group-hover:text-ink">{note.title}</span>
                    <span className="truncate font-mono text-[0.625rem] text-ink-4">
                      {note.subfolder ?? note.folder}
                    </span>
                  </button>
                  <span className="font-mono text-[0.625rem] tabular-nums text-ink-4">
                    {note.cards.length}
                  </span>
                  <button
                    onClick={() => openCreate(note.path ? note : null)}
                    title="Write a card for this note"
                    className="-my-1.5 px-1 py-1.5 font-mono text-[0.625rem] text-ink-4 hover:text-ink"
                  >
                    + card
                  </button>
                </div>

                {open &&
                  note.cards.map((c) => {
                    const tier = TIERS[tierOf(c)];
                    const face =
                      c.cloze_text && c.type === 'cloze' ? renderCloze(c.cloze_text, false) : c.front;
                    const rev =
                      c.cloze_text && c.type === 'cloze' ? renderCloze(c.cloze_text, true) : c.back;

                    return (
                      <div
                        key={c.id}
                        onClick={() => openEdit(c, note)}
                        className="group flex cursor-pointer items-baseline gap-3 border-b border-ink-4/30 px-3 py-3 hover:bg-surface active:bg-surface sm:px-4 sm:py-2.5"
                      >
                        <span className="flex w-4 shrink-0 items-center gap-1.5 sm:w-24">
                          <span className={`inline-block h-1.5 w-1.5 rounded-full ${tier.dot}`} />
                          <span className={`hidden font-mono text-[0.625rem] sm:inline ${tier.color}`}>
                            {tier.label}
                          </span>
                        </span>

                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-ink-2">{face}</p>
                          {rev && <p className="truncate text-xs text-ink-3">{rev}</p>}
                        </div>

                        <span className="hidden w-28 shrink-0 truncate font-mono text-[0.625rem] text-ink-4 sm:block">
                          {c.angle}
                          {c.type !== 'qa' && ` · ${c.type}`}
                        </span>
                        <span
                          className="hidden w-14 shrink-0 text-right font-mono text-[0.625rem] tabular-nums text-ink-4 xs:block"
                          title={`${c.reps} reviews · ${c.lapses} lapses${c.stability ? ` · stability ${Math.round(c.stability)}d` : ''}`}
                        >
                          {c.status === 'active' ? when(c.due) : '—'}
                        </span>

                        {/* Both actions live on the row and appear on hover. Deleting from here
                            takes a confirm, since the row is one click away from being opened. */}
                        <span className="flex w-11 shrink-0 items-baseline justify-end gap-2.5 font-mono text-[0.625rem] text-ink-4 transition-opacity sm:w-16 sm:opacity-0 sm:group-hover:opacity-100">
                          <span className="hidden sm:inline">edit</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setPendingDelete(c);
                            }}
                            disabled={busy}
                            aria-label="Delete card"
                            className="-my-2 px-1.5 py-2 transition-colors hover:text-mem-fresh disabled:opacity-40"
                          >
                            ✕
                          </button>
                        </span>
                      </div>
                    );
                  })}
              </section>
            );
          })}

          {!filtered.length && (
            <p className="p-8 text-sm text-ink-3">
              {query || tierFilter ? 'Nothing matches.' : 'No cards yet.'}
            </p>
          )}
        </div>
      </div>

      {/* One modal for both writing and fixing. Escape closes, ⌘↵ saves. */}
      {modal && (
        <div
          onClick={() => setModal(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg/95 px-4 py-6 backdrop-blur-sm sm:px-6 sm:py-10"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void save();
              if (e.key === 'Escape') setModal(null);
            }}
            className="rise w-full max-w-xl"
          >
            <div className="flex items-baseline justify-between text-xs text-ink-3">
              <span>{modal.mode === 'edit' ? 'Edit card' : 'New card'}</span>
              <span className="truncate pl-4 text-ink-4">
                {modal.note ? modal.note.title : 'no source note'}
              </span>
            </div>

            <div className="card mt-4 space-y-4 p-6">
              <div>
                <label className="mb-2 block text-[0.6875rem] uppercase tracking-[0.18em] text-ink-3">
                  Prompt
                </label>
                <textarea
                  value={draft.front}
                  onChange={(e) => setDraft({ ...draft, front: e.target.value })}
                  rows={2}
                  autoFocus
                  placeholder="The question you want to be asked in six months…"
                  className="w-full resize-none bg-transparent text-lg leading-snug font-light placeholder:text-ink-4"
                />
              </div>

              <div className="h-px w-10 bg-ink-4" />

              <div>
                <label className="mb-2 block text-[0.6875rem] uppercase tracking-[0.18em] text-ink-3">
                  Answer
                </label>
                <textarea
                  value={draft.back}
                  onChange={(e) => setDraft({ ...draft, back: e.target.value })}
                  rows={3}
                  placeholder="Leave empty if the value is being asked, not recalling."
                  className="w-full resize-none bg-transparent leading-relaxed text-ink-2 placeholder:text-ink-4"
                />
              </div>

              <div className="flex flex-wrap items-center gap-3 border-t border-ink-4 pt-4">
                <select
                  value={draft.angle}
                  onChange={(e) => setDraft({ ...draft, angle: e.target.value as Angle })}
                  disabled={modal.mode === 'edit'}
                  className="rounded border border-ink-4 bg-surface px-2 py-1 font-mono text-[0.6875rem] text-ink-2 disabled:opacity-40"
                >
                  {ANGLES.map((a) => (
                    <option key={a} value={a} className="bg-surface">
                      {a}
                    </option>
                  ))}
                </select>
                <select
                  value={draft.type}
                  onChange={(e) => setDraft({ ...draft, type: e.target.value as CardType })}
                  disabled={modal.mode === 'edit'}
                  className="rounded border border-ink-4 bg-surface px-2 py-1 font-mono text-[0.6875rem] text-ink-2 disabled:opacity-40"
                >
                  {CARD_TYPES.map((t) => (
                    <option key={t} value={t} className="bg-surface">
                      {t}
                    </option>
                  ))}
                </select>

                {modal.mode === 'edit' && (
                  <span
                    className="ml-auto font-mono text-[0.625rem] text-ink-4"
                    title="reviews · lapses · stability"
                  >
                    {modal.card.reps} rev · {modal.card.lapses} lapse
                    {modal.card.stability ? ` · ${Math.round(modal.card.stability)}d stable` : ''}
                  </span>
                )}
              </div>
            </div>

            <div className="mt-4 flex items-center gap-6 text-xs text-ink-3">
              <button
                onClick={() => void save()}
                disabled={busy || !draft.front.trim()}
                className="rounded border border-ink-4 px-3 py-1.5 hover:border-ink-2 hover:text-ink disabled:opacity-30"
              >
                {busy ? 'Saving…' : modal.mode === 'edit' ? 'Save' : 'Add card'}
              </button>
              <button onClick={() => setModal(null)} className="hover:text-ink">
                Cancel
              </button>
              {modal.mode === 'edit' && (
                <button
                  onClick={() => setPendingDelete(modal.card)}
                  className="ml-auto hover:text-ink"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Deleting is the only thing on this page that can't be undone, so it gets its own
          confirmation — shown as the card itself, so what you're about to lose is the thing you
          are looking at. Sits above the edit modal, which stays open behind it. */}
      {pendingDelete && (
        <div
          onClick={() => setPendingDelete(null)}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-bg/95 px-4 backdrop-blur-sm sm:px-6"
        >
          <div onClick={(e) => e.stopPropagation()} className="rise w-full max-w-md">
            <p className="text-xs uppercase tracking-[0.18em] text-ink-3">Delete this card?</p>

            <div className="card mt-4 px-5 py-4">
              <p className="text-sm leading-snug text-ink">
                {pendingDelete.cloze_text && pendingDelete.type === 'cloze'
                  ? renderCloze(pendingDelete.cloze_text, false)
                  : pendingDelete.front}
              </p>
              {pendingDelete.back && (
                <p className="mt-1.5 text-sm leading-snug text-ink-3">{pendingDelete.back}</p>
              )}
              <p className="mt-3 font-mono text-[0.5625rem] uppercase tracking-wider text-ink-4">
                {pendingDelete.reps} review{pendingDelete.reps === 1 ? '' : 's'} ·{' '}
                {pendingDelete.lapses} lapse{pendingDelete.lapses === 1 ? '' : 's'}
              </p>
            </div>

            <p className="mt-4 text-xs leading-relaxed text-ink-4">
              Its review history goes with it. This can&rsquo;t be undone.
            </p>

            <div className="mt-5 flex items-center gap-6 text-xs">
              <button
                onClick={() => void remove()}
                disabled={busy}
                autoFocus
                className="rounded border border-mem-fresh/50 px-3 py-1.5 text-mem-fresh transition-colors hover:border-mem-fresh hover:bg-mem-fresh/10 disabled:opacity-40"
              >
                {busy ? 'Deleting…' : 'Delete'}
              </button>
              <button
                onClick={() => setPendingDelete(null)}
                className="text-ink-3 transition-colors hover:text-ink"
              >
                Keep it
              </button>
              <span className="ml-auto font-mono text-[0.625rem] text-ink-4">
                <kbd>esc</kbd> to keep
              </span>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
