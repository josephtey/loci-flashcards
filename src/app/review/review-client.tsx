'use client';

import Link from 'next/link';
import { HomeButton } from '@/components/home-button';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RichText } from '@/components/rich-text';
import { hasCloze, renderCloze } from '@/lib/cloze';
import { formatInterval, preview } from '@/lib/fsrs';
import { RATING_LABELS, type DueCard, type RatingValue, type StillEndorse } from '@/lib/types';

const RATINGS: RatingValue[] = [1, 2, 3, 4];

export interface SessionProps {
  cards: DueCard[];
  /**
   * `new` is a card's first encounter: same four grades, and the same escape hatch. Dropping is
   * how a bad card leaves the system now that nothing gates the deck — and it stays available in
   * review, because a card can take three encounters to reveal that it was never worth keeping.
   */
  mode: 'new' | 'review';
}

export function Review({ cards, mode }: SessionProps) {
  const isNew = mode === 'new';
  const router = useRouter();
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [endorse, setEndorse] = useState<StillEndorse | null>(null);
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState(false);
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [patched, setPatched] = useState<Record<string, { front: string; back: string | null }>>({});
  /** Ratings already given this session, so a revisited card shows what you picked. */
  const [given, setGiven] = useState<Record<string, RatingValue>>({});
  const reasonRef = useRef<HTMLInputElement>(null);
  const frontRef = useRef<HTMLTextAreaElement>(null);
  // Stamped when a card is shown, read when it's graded. Set in an effect rather than during
  // render — `Date.now()` in a render body is impure and gives an unstable value on re-render.
  const shownAt = useRef(0);

  const card = cards[idx];
  const done = idx >= cards.length;
  const isClaim = card?.angle === 'claim';

  // Interval hints come from the same scheduler the server will run, so what the buttons promise
  // is what actually happens.
  const intervals = useMemo(() => {
    if (!card) return null;
    const now = new Date();
    const p = preview(card, now);
    return Object.fromEntries(
      RATINGS.map((r) => [r, formatInterval(now, p[r])]),
    ) as Record<RatingValue, string>;
  }, [card]);

  useEffect(() => {
    shownAt.current = Date.now();
  }, [idx]);

  const advance = useCallback(() => {
    setFlipped(false);
    setEndorse(null);
    setDropping(false);
    setReason('');
    setEditing(false);
    setIdx((i) => i + 1);
  }, []);

  const send = useCallback(
    async (body: Record<string, unknown>) => {
      if (!card || busy) return;
      setBusy(true);
      try {
        await fetch(`/api/review/${card.id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, duration_ms: Date.now() - shownAt.current }),
        });
        advance();
      } finally {
        setBusy(false);
      }
    },
    [card, busy, advance],
  );

  const gradeCard = useCallback(
    (rating: RatingValue) => {
      if (!card) return;
      const already = given[card.id] !== undefined;
      setGiven((g) => ({ ...g, [card.id]: rating }));
      return send({
        // A card you already graded this session is a correction, not a new review — the server
        // rewinds to the state before that grade so the schedule lands where the right answer
        // would have put it.
        action: already ? 'regrade' : 'grade',
        rating,
        still_endorse: endorse ?? undefined,
      });
    },
    [card, given, send, endorse],
  );

  const goBack = useCallback(() => {
    if (idx === 0) return;
    setFlipped(true);
    setEditing(false);
    setDropping(false);
    setIdx((i) => i - 1);
  }, [idx]);

  useEffect(() => {
    if (done) router.refresh();
  }, [done, router]);

  const beginDrop = useCallback(() => {
    setDropping(true);
    requestAnimationFrame(() => reasonRef.current?.focus());
  }, []);

  const drop = useCallback(
    () => send({ action: 'drop', reason: reason.trim() || undefined }),
    [send, reason],
  );

  const startEditing = useCallback(() => {
    if (!card) return;
    setFront(patched[card.id]?.front ?? card.front);
    setBack(patched[card.id]?.back ?? card.back ?? '');
    setEditing(true);
    setFlipped(true);
    requestAnimationFrame(() => frontRef.current?.focus());
  }, [card, patched]);

  /** Save the edit and stay on the card — you still owe it a grade. */
  const saveEdit = useCallback(async () => {
    if (!card || !front.trim()) return;
    setBusy(true);
    try {
      await fetch(`/api/cards/${card.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'edit', front: front.trim(), back: back.trim() || null }),
      });
      setPatched((p) => ({ ...p, [card.id]: { front: front.trim(), back: back.trim() || null } }));
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }, [card, front, back]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (done || busy) return;

      if (editing) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          void saveEdit();
        } else if (e.key === 'Escape') {
          setEditing(false);
        }
        return;
      }

      if (dropping) {
        if (e.key === 'Escape') {
          setDropping(false);
          setReason('');
        }
        return;
      }

      if (e.key === 'e') {
        e.preventDefault();
        startEditing();
        return;
      }

      if (e.key === 'ArrowLeft' || e.key === 'u') {
        e.preventDefault();
        goBack();
        return;
      }

      if (e.key === 'd') {
        e.preventDefault();
        beginDrop();
        return;
      }

      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        setFlipped((v) => !v);
        return;
      }
      if (flipped && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        void gradeCard(Number(e.key) as RatingValue);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [done, busy, flipped, dropping, editing, send, gradeCard, startEditing, saveEdit, goBack, beginDrop]);

  if (done) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center px-6">
        <p className="rise text-ink-3">
          Done — {cards.length} {isNew ? 'new card' : 'review'}
          {cards.length === 1 ? '' : 's'}.
        </p>
        <Link href="/" className="mt-8 text-sm text-ink-3 transition-colors hover:text-ink">
          Home
        </Link>
      </main>
    );
  }

  // A cloze card is one sentence shown twice — blanked, then filled. `front`/`back` are only
  // used when there's no cloze text to work with.
  const local = patched[card.id];
  const isCloze = card.type === 'cloze' && hasCloze(card.cloze_text) && !local;
  const question = isCloze ? renderCloze(card.cloze_text!, false) : (local?.front ?? card.front);
  const answer = isCloze ? renderCloze(card.cloze_text!, true) : (local?.back ?? card.back);

  return (
    <main className="safe-b mx-auto flex min-h-dvh max-w-3xl flex-col px-5 pt-6 pb-14 sm:px-8 sm:py-10">
      <header className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <HomeButton />
          <h1 className="text-lg font-light">{isNew ? 'Learn new cards' : 'Review'}</h1>
          <p className="mt-0.5 text-xs text-ink-3 tabular-nums">
            {idx + 1} of {cards.length} {isNew ? 'never seen' : 'due'}
          </p>
        </div>

      </header>

      {/* The card. Centred, alone, nothing else competing.

          The entrance animation lives on the outer wrapper, never on `.flip-inner`. Both would
          animate `transform`, and a keyframe with `animation-fill-mode: both` keeps its final
          value applied — which outranks a normal declaration in the cascade and silently pins
          the card to `transform: none`, so the flip class toggles but nothing rotates. */}
      {editing ? (
        <div className="rise flex flex-1 flex-col justify-center py-6 sm:py-12">
          <div className="card px-5 py-6 sm:px-8 sm:py-8">
            <label className="mb-2 block text-[0.6875rem] uppercase tracking-[0.18em] text-ink-3">
              Prompt
            </label>
            <textarea
              ref={frontRef}
              value={front}
              onChange={(e) => setFront(e.target.value)}
              rows={2}
              className="w-full resize-none bg-transparent text-xl leading-snug font-light"
            />
            <div className="my-6 h-px w-10 bg-ink-4" />
            <label className="mb-2 block text-[0.6875rem] uppercase tracking-[0.18em] text-ink-3">
              Answer
            </label>
            <textarea
              value={back}
              onChange={(e) => setBack(e.target.value)}
              rows={3}
              placeholder="Leave empty if the value is being asked, not recalling."
              className="w-full resize-none bg-transparent leading-relaxed text-ink-2 placeholder:text-ink-4"
            />
          </div>
          <div className="mt-4 flex items-center gap-6 text-xs text-ink-3">
            <button onClick={() => void saveEdit()} disabled={busy || !front.trim()} className="hover:text-ink disabled:opacity-30">
              <kbd>⌘</kbd>
              <kbd>↵</kbd> save
            </button>
            <button onClick={() => setEditing(false)} className="hover:text-ink">
              <kbd>esc</kbd> cancel
            </button>
            {card.type === 'cloze' && (
              <span className="ml-auto text-ink-4">editing converts this cloze to a Q&amp;A card</span>
            )}
          </div>
        </div>
      ) : (
      <div className="flip-scene flex flex-1 items-center justify-center py-6 sm:py-12">
        <div key={card.id} className="deal w-full">
          <div
            data-flipped={flipped}
            onClick={() => setFlipped((v) => !v)}
            className="flip-inner relative w-full cursor-pointer select-none"
            style={{ minHeight: 'min(18rem, 42vh)' }}
          >
            {/* Front */}
            <div className="card flip-face flex min-h-[min(18rem,42vh)] flex-col items-center justify-center px-6 py-10 text-center sm:px-10 sm:py-12">
              <RichText
                text={question}
                className="text-[1.375rem] font-light leading-snug sm:text-[2rem]"
              />
              {isCloze && card.front && <p className="mt-6 text-sm text-ink-3">{card.front}</p>}
            </div>

            {/* Back */}
            <div className="card flip-face flip-face--back absolute inset-0 flex min-h-[min(18rem,42vh)] flex-col items-center justify-center px-6 py-10 text-center sm:px-10 sm:py-12">
              {answer ? (
                <RichText text={answer} className="text-lg font-light leading-relaxed text-ink sm:text-xl" />
              ) : (
                <p className="text-sm text-ink-3">
                  No answer — the value here is being asked, not recalling.
                </p>
              )}
              {card.context && (
                <p className="mt-8 max-w-lg text-sm leading-relaxed text-ink-3">{card.context}</p>
              )}
              <p className="mt-8 font-mono text-[0.625rem] tracking-wide text-ink-4">
                {card.note_title}
              </p>
            </div>
          </div>
        </div>
      </div>
      )}

      {dropping && (
        <div className="rise mb-4 flex items-center gap-3 border-t border-ink-4 pt-5">
          <input
            ref={reasonRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void drop();
              }
            }}
            placeholder="Why drop it? (teaches the next scan)"
            className="min-w-0 flex-1 bg-transparent text-sm placeholder:text-ink-4"
          />
          <kbd>↵</kbd>
          <button
            onClick={() => void drop()}
            className="shrink-0 rounded border border-ink-4 px-3 py-1.5 text-xs text-ink-3 transition-colors hover:border-mem-fresh hover:text-mem-fresh"
          >
            Drop
          </button>
          <button
            onClick={() => setDropping(false)}
            className="shrink-0 text-xs text-ink-4 transition-colors hover:text-ink-2"
          >
            Cancel
          </button>
        </div>
      )}

      <footer className="border-t border-ink-4 pt-6">
        {!flipped ? (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-3">
            <button onClick={() => setFlipped(true)} className="py-2 text-left transition-colors hover:text-ink sm:py-0">
              <kbd>space</kbd> reveal
            </button>
            <button onClick={startEditing} className="py-2 text-left transition-colors hover:text-ink sm:py-0">
              <kbd>e</kbd> edit
            </button>
            <button onClick={beginDrop} className="py-2 text-left transition-colors hover:text-ink sm:py-0">
              <kbd>d</kbd> drop
            </button>
            {idx > 0 && (
              <button onClick={goBack} className="py-2 text-left transition-colors hover:text-ink sm:py-0">
                <kbd>←</kbd> back
              </button>
            )}
          </div>
        ) : (
          <div className="rise space-y-6">
            {/* Claim cards ask a second question: do you still hold this? A shift flags the
                source note for revision rather than silently drilling a stale belief. */}
            {isClaim && (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
                <span className="text-ink-3">Still hold this?</span>
                {(['yes', 'shifted', 'no'] as StillEndorse[]).map((v) => (
                  <button
                    key={v}
                    onClick={() => setEndorse(v)}
                    className={`transition-colors ${
                      endorse === v ? 'text-ink underline underline-offset-4' : 'text-ink-3 hover:text-ink-2'
                    }`}
                  >
                    {v === 'yes' ? 'yes' : v === 'shifted' ? 'shifted' : 'no longer'}
                  </button>
                ))}
              </div>
            )}

            <div className="grid grid-cols-4 gap-2 sm:gap-3">
              {RATINGS.map((r) => {
                const chosen = given[card.id] === r;
                return (
                <button
                  key={r}
                  onClick={() => void gradeCard(r)}
                  disabled={busy}
                  className={`group rounded border py-4 transition-colors active:bg-surface disabled:opacity-40 ${
                    chosen ? 'border-ink bg-surface' : 'border-ink-4 hover:border-ink-2'
                  }`}
                >
                  <div className={`text-sm ${chosen ? 'text-ink' : 'text-ink-2 group-hover:text-ink'}`}>
                    {RATING_LABELS[r]}
                  </div>
                  <div className="mt-1 font-mono text-[0.625rem] tabular-nums text-ink-4 group-hover:text-ink-3">
                    {intervals?.[r]}
                  </div>
                </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-3">
              <span className="hidden sm:inline">
                <kbd>1</kbd>–<kbd>4</kbd> {given[card.id] ? 'change grade' : 'grade'}
              </span>
              <button onClick={startEditing} className="py-2 text-left transition-colors hover:text-ink sm:py-0">
                <kbd>e</kbd> edit
              </button>
              <button onClick={beginDrop} className="py-2 text-left transition-colors hover:text-ink sm:py-0">
                <kbd>d</kbd> drop
              </button>
              {idx > 0 && (
                <button onClick={goBack} className="py-2 text-left transition-colors hover:text-ink sm:py-0">
                  <kbd>←</kbd> back
                </button>
              )}
              {card.lapses >= 2 && (
                <span className="ml-auto text-ink-2">
                  lapsed {card.lapses}× — worth rewriting
                </span>
              )}
            </div>
          </div>
        )}
      </footer>
    </main>
  );
}
