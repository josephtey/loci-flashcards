'use client';

import Link from 'next/link';
import { HomeButton } from '@/components/home-button';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { RichText } from '@/components/rich-text';
import { cardContext } from '@/lib/card-context';
import { hasCloze, renderCloze } from '@/lib/cloze';
import { formatInterval, preview } from '@/lib/fsrs';
import { gradable, type GraderStatus } from '@/lib/grading';
import {
  RATING_LABELS,
  type DueCard,
  type ExplainResult,
  type GradeResult,
  type RatingValue,
  type StillEndorse,
} from '@/lib/types';

const RATINGS: RatingValue[] = [1, 2, 3, 4];

/**
 * Type size for a card face, from how much there is to say.
 *
 * A fixed 2rem is right for "What is Cell Painting?" and far too big for a three-clause
 * explanation, which used to run past the bottom of the card. Sizing by length keeps the short
 * prompts feeling like the single question they are, without letting a long one overflow.
 *
 * Character count is a crude proxy for rendered height and deliberately so — the alternative is
 * measuring the DOM and re-rendering, which means a visible reflow on every card. The buckets
 * are generous enough that being a few characters out never matters.
 */
function scale(text: string, side: 'front' | 'back'): string {
  const n = text.length;
  if (side === 'front') {
    if (n < 70) return 'text-[1.375rem] sm:text-[2rem]';
    if (n < 130) return 'text-[1.25rem] sm:text-[1.625rem]';
    if (n < 240) return 'text-[1.125rem] sm:text-[1.375rem]';
    return 'text-base sm:text-[1.125rem]';
  }
  if (n < 130) return 'text-lg sm:text-xl';
  if (n < 300) return 'text-base sm:text-lg';
  return 'text-sm sm:text-base';
}

/**
 * Which grade the session asks *you* for.
 *
 * `self` is the original flow: reveal the answer, decide for yourself how well it came back.
 * `recall` makes you type the answer first and has a local model score it — the honest version,
 * since it is impossible to think "I knew that" at a blank screen and be wrong.
 *
 * The choice lives in localStorage rather than the database. It is a property of how you feel
 * like reviewing right now, not a fact about the deck, and a round-trip to change it would make
 * the toggle feel like a setting instead of a switch.
 */
type GradeMode = 'self' | 'recall';
const MODE_KEY = 'loci:grade-mode';

/**
 * The mode, read straight out of localStorage as an external store.
 *
 * The obvious shape — `useState('self')` plus an effect that corrects it — is a cascading
 * render, and React now flags it. `useSyncExternalStore` says the same thing honestly: the
 * server has no idea what the mode is, the browser does, and the two are reconciled once
 * without a wasted pass.
 */
const modeListeners = new Set<() => void>();

function readMode(): GradeMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'recall' ? 'recall' : 'self';
  } catch {
    // Private browsing, or storage disabled. Self-grading is a fine place to land.
    return 'self';
  }
}

/** No storage on the server, so it renders the default and hydration corrects it. */
function serverMode(): GradeMode {
  return 'self';
}

function subscribeMode(cb: () => void): () => void {
  modeListeners.add(cb);
  // Also honours the toggle being flipped in another tab.
  window.addEventListener('storage', cb);
  return () => {
    modeListeners.delete(cb);
    window.removeEventListener('storage', cb);
  };
}

function writeMode(next: GradeMode): void {
  try {
    localStorage.setItem(MODE_KEY, next);
  } catch {}
  for (const cb of modeListeners) cb();
}

export interface SessionProps {
  cards: DueCard[];
  /**
   * `new` is a card's first encounter: same four grades, and the same escape hatch. Dropping is
   * how a bad card leaves the system now that nothing gates the deck — and it stays available in
   * review, because a card can take three encounters to reveal that it was never worth keeping.
   */
  mode: 'new' | 'review';
  /** Resolved on the server: is there an Ollama to grade against, and which model. */
  grader: GraderStatus;
  /** Resolved on the server: is there a model to explain a card against, and which one. */
  explainer: GraderStatus;
  /** Commit the model's grade without waiting to be told to. Off until it has earned it. */
  autoAccept: boolean;
}

export function Review({ cards, mode, grader, explainer, autoAccept }: SessionProps) {
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

  // ── recall mode ────────────────────────────────────────────────────────────
  const gradeMode = useSyncExternalStore(subscribeMode, readMode, serverMode);
  const [typed, setTyped] = useState('');
  const [grading, setGrading] = useState(false);
  const [verdict, setVerdict] = useState<GradeResult | null>(null);
  /** Why this card is being graded by hand after all — an unreachable model, or `s`. */
  const [bypass, setBypass] = useState<string | null>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  // Stamped when a card is shown, read when it's graded. Set in an effect rather than during
  // render — `Date.now()` in a render body is impure and gives an unstable value on re-render.
  const shownAt = useRef(0);

  // ── copy for a chat ────────────────────────────────────────────────────────
  // Holds the id of the card just copied, so the confirmation belongs to that card and moving on
  // clears it rather than leaving "copied" under a card you have not copied.
  const [copied, setCopied] = useState<string | null>(null);

  // ── explain ────────────────────────────────────────────────────────────────
  // Keyed by card id so a re-visited card shows what it already explained rather than asking
  // the model again. `explaining` tracks only the in-flight request, so a slow one can't be
  // confused with a card that simply has no explanation yet.
  const [explanations, setExplanations] = useState<Record<string, ExplainResult>>({});
  const [explaining, setExplaining] = useState(false);
  const [explainError, setExplainError] = useState<string | null>(null);

  const card = cards[idx];
  const done = idx >= cards.length;
  const isClaim = card?.angle === 'claim';

  // An edit made this session is already saved, so the server will grade against the new text.
  // Using the patched copy here keeps this screen's idea of the card and the grader's identical.
  const effective = card && { ...card, ...(patched[card.id] ?? {}) };

  const recall = gradeMode === 'recall' && grader.available;
  /** Type an answer for this particular card — false for cards with no reference answer. */
  const typing = Boolean(recall && effective && gradable(effective) && !bypass);

  const setMode = useCallback((next: GradeMode) => {
    writeMode(next);
    // Switching mid-card abandons whatever the old mode had going. Leaving a verdict on screen
    // after a switch to self-grading would show a proposal nothing can accept.
    setVerdict(null);
    setTyped('');
    setBypass(null);
  }, []);

  // Pay the model's load time now rather than on the first card you answer. A cold 4B model
  // spends the better part of twenty seconds reading weights off disk; that belongs in the gap
  // where you are still reading the first question, not in the pause after you answer it.
  useEffect(() => {
    if (!recall) return;
    void fetch('/api/grade', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ warm: true }),
    }).catch(() => {});
  }, [recall]);

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
    setTyped('');
    setVerdict(null);
    setBypass(null);
    setExplainError(null);
    setCopied(null);
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
        // What you typed and what the machine made of it, whether or not you took its advice.
        // `rating` is yours; `grader_rating` is its guess. Keeping both is the only way to find
        // out later where the auto-grader is wrong — and it is the reason this mode exists in a
        // propose-and-confirm shape rather than just grading you silently.
        typed_answer: typed.trim() || undefined,
        grader_rating: verdict?.rating,
        grader_verdict: verdict?.verdict,
        grader_missing: verdict?.missing,
        grader_model: verdict?.model,
        grader_ms: verdict?.latency_ms,
      });
    },
    [card, given, send, endorse, typed, verdict],
  );

  /**
   * Send the typed answer off to be graded, then reveal.
   *
   * A grader that fails does not cost you the card: `bypass` drops this one card back to
   * self-grading with a note saying why, the answer is revealed either way, and the session
   * carries on. The alternative — an error toast over a card you have already answered — would
   * make a flaky background service into a reason to stop reviewing.
   */
  const submitAnswer = useCallback(async () => {
    if (!card || grading || busy) return;
    setGrading(true);
    answerRef.current?.blur();
    try {
      const res = await fetch('/api/grade', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cardId: card.id, answer: typed }),
      });
      const data = (await res.json()) as
        | ({ ok: true } & GradeResult)
        | { ok: false; reason: string };

      if (data.ok) {
        setVerdict(data);
        if (autoAccept) {
          setFlipped(true);
          await gradeCard(data.rating);
          return;
        }
      } else {
        setBypass(data.reason);
      }
    } catch {
      setBypass('The grader could not be reached — grade this one yourself.');
    } finally {
      setGrading(false);
      setFlipped(true);
    }
  }, [card, grading, busy, typed, autoAccept, gradeCard]);

  /**
   * Put the whole card on the clipboard, for asking somewhere else.
   *
   * Only once the answer is up: the block contains the answer, and copying it while you are still
   * trying to remember would spoil the card to save two keystrokes. Same reason explain sits on
   * this side.
   */
  const copyCard = useCallback(async () => {
    if (!card || !flipped) return;
    try {
      // Mirror what is actually on screen: an edited card renders as plain front/back, so its
      // cloze source goes with the edit. Copying the original would hand over text you changed.
      const patch = patched[card.id];
      await navigator.clipboard.writeText(
        cardContext(patch ? { ...card, ...patch, cloze_text: null } : card),
      );
      setCopied(card.id);
    } catch {
      // A browser can refuse this outright — no permission, or an insecure origin. Saying so
      // beats a button that silently does nothing.
      setCopied('failed');
    }
  }, [card, flipped, patched]);

  const explainCard = useCallback(async () => {
    // Elaborates on the answer — nothing to elaborate on before it's revealed.
    if (!card || !flipped || explaining || explanations[card.id] || !explainer.available) return;
    setExplaining(true);
    setExplainError(null);
    try {
      const res = await fetch('/api/explain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cardId: card.id }),
      });
      const data = (await res.json()) as ({ ok: true } & ExplainResult) | { ok: false; reason: string };
      if (data.ok) {
        setExplanations((e) => ({ ...e, [card.id]: data }));
      } else {
        setExplainError(data.reason);
      }
    } catch {
      setExplainError('Could not reach the explainer.');
    } finally {
      setExplaining(false);
    }
  }, [card, flipped, explaining, explanations, explainer.available]);

  /** Take the machine at its word. */
  const acceptVerdict = useCallback(() => {
    if (verdict) void gradeCard(verdict.rating);
  }, [verdict, gradeCard]);

  const goBack = useCallback(() => {
    if (idx === 0) return;
    setFlipped(true);
    setEditing(false);
    setDropping(false);
    setExplainError(null);
    setCopied(null);
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

      // While the answer box has focus it owns every key. Without this, typing the word
      // "producer" would edit the card on the `e` and drop it on the `d`.
      const el = e.target as HTMLElement | null;
      if (el?.tagName === 'TEXTAREA' || el?.tagName === 'INPUT') return;

      // A verdict is on screen and waiting to be accepted. Enter takes it; 1-4 overrides it and
      // falls through to the grading branch below.
      if (verdict && e.key === 'Enter') {
        e.preventDefault();
        acceptVerdict();
        return;
      }

      // Hand this one card back to yourself — when the grader is being obtuse, or the answer is
      // a diagram, or you simply do not feel like typing it.
      if (typing && !flipped && e.key === 's') {
        e.preventDefault();
        setBypass('Graded by hand.');
        return;
      }

      if (e.key === 'e') {
        e.preventDefault();
        startEditing();
        return;
      }

      // Elaborates on the answer, so it only makes sense once the answer is on screen.
      if (e.key === '?' && flipped) {
        e.preventDefault();
        void explainCard();
        return;
      }

      // Same reason: the block it copies contains the answer.
      if (e.key === 'c' && flipped) {
        e.preventDefault();
        void copyCard();
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
        // In recall mode the answer is the price of the reveal. Flipping early would turn the
        // mode into a slower version of self-grading.
        if (typing && !flipped) {
          answerRef.current?.focus();
          return;
        }
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
  }, [
    done, busy, flipped, dropping, editing, send, gradeCard, startEditing, saveEdit, goBack,
    beginDrop, verdict, acceptVerdict, typing, explainCard, copyCard,
  ]);

  // The answer box wants focus the moment a card arrives, so a session is type-type-enter with
  // no clicking. Skipped while grading, or the blur that submits would be undone.
  useEffect(() => {
    if (typing && !flipped && !grading) answerRef.current?.focus();
  }, [idx, typing, flipped, grading]);

  if (done) {
    return (
      <main className="safe-b safe-t [--safe-b-base:2.5rem] [--safe-t-base:2.5rem] flex min-h-dvh flex-col items-center justify-center px-6">
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
    <main className="safe-b safe-t mx-auto flex min-h-dvh max-w-3xl flex-col px-5 sm:px-8 sm:[--safe-t-base:2.5rem]">
      <header className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <HomeButton />
          <h1 className="text-lg font-light">{isNew ? 'Learn new cards' : 'Review'}</h1>
          <p className="mt-0.5 text-xs text-ink-3 tabular-nums">
            {idx + 1} of {cards.length} {isNew ? 'never seen' : 'due'}
          </p>
        </div>

        {/* Two ways to answer the same deck. Disabled rather than hidden when there is no model
            to talk to — a toggle that vanishes reads as a bug, one that explains itself does not. */}
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-1 text-[0.6875rem]">
            {(['self', 'recall'] as GradeMode[]).map((m) => {
              const active = gradeMode === m;
              const blocked = m === 'recall' && !grader.available;
              return (
                <button
                  key={m}
                  onClick={() => !blocked && setMode(m)}
                  disabled={blocked}
                  title={blocked ? (grader.reason ?? undefined) : undefined}
                  className={`rounded px-2 py-1 uppercase tracking-[0.14em] transition-colors ${
                    active
                      ? 'bg-surface text-ink'
                      : blocked
                        ? 'cursor-not-allowed text-ink-4'
                        : 'text-ink-3 hover:text-ink'
                  }`}
                >
                  {m === 'self' ? 'self' : 'type it'}
                </button>
              );
            })}
          </div>
          {recall && (
            <span className="font-mono text-[0.625rem] text-ink-4">{grader.model}</span>
          )}
          {gradeMode === 'recall' && !grader.available && grader.reason && (
            <span className="max-w-[15rem] text-right text-[0.625rem] leading-snug text-ink-4">
              {grader.reason}
            </span>
          )}
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
                className={`font-light leading-snug ${scale(question, 'front')}`}
              />
              {isCloze && card.front && <p className="mt-6 text-sm text-ink-3">{card.front}</p>}
            </div>

            {/* Back */}
            <div className="card flip-face flip-face--back flex min-h-[min(18rem,42vh)] flex-col items-center justify-center px-6 py-10 text-center sm:px-10 sm:py-12">
              {answer ? (
                <RichText
                  text={answer}
                  className={`font-light leading-relaxed text-ink ${scale(answer, 'back')}`}
                />
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

      {/* Elaborates on the answer, so it only shows alongside it — never on the question side,
          and not left dangling if you flip back before grading. */}
      {flipped && (explaining || explanations[card.id] || explainError) && (
        <div className="rise mb-4 space-y-3 border-l-2 border-ink-4 pl-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[0.6875rem] uppercase tracking-[0.18em] text-ink-3">
              Explain
            </span>
            {explanations[card.id] && (
              <span className="font-mono text-[0.625rem] tabular-nums text-ink-4">
                {explanations[card.id].model} ·{' '}
                {(explanations[card.id].latency_ms / 1000).toFixed(1)}s
              </span>
            )}
          </div>
          {explaining ? (
            <p className="text-sm text-ink-3">thinking…</p>
          ) : explanations[card.id] ? (
            <RichText
              text={explanations[card.id].explanation}
              className="text-sm leading-relaxed text-ink-2"
            />
          ) : (
            <p className="text-sm text-ink-3">{explainError}</p>
          )}
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
        {!flipped && typing ? (
          /* Recall mode: the answer is the price of the reveal. */
          <div className="rise space-y-3">
            <textarea
              ref={answerRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                // Enter submits, because most answers are one line and reaching for a modifier
                // every card would be the slowest part of the loop. Shift+Enter still breaks.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submitAnswer();
                }
              }}
              disabled={grading}
              rows={3}
              placeholder="Answer from memory…"
              className="w-full resize-none rounded border border-ink-4 bg-surface px-4 py-3 leading-relaxed text-ink placeholder:text-ink-4 focus:border-ink-2 focus:outline-none disabled:opacity-50"
            />
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-3">
              {grading ? (
                <span className="text-ink-2">grading…</span>
              ) : (
                <button onClick={() => void submitAnswer()} className="py-2 text-left transition-colors hover:text-ink sm:py-0">
                  <kbd>↵</kbd> answer
                </button>
              )}
              <button
                onClick={() => setBypass('Graded by hand.')}
                className="py-2 text-left transition-colors hover:text-ink sm:py-0"
              >
                <kbd>s</kbd> skip the grader
              </button>
              <button onClick={startEditing} className="py-2 text-left transition-colors hover:text-ink sm:py-0">
                <kbd>e</kbd> edit
              </button>
              <button
                onClick={() => void copyCard()}
                title="Copy the question, answer, context and source passage as markdown"
                className="py-2 text-left transition-colors hover:text-ink sm:py-0"
              >
                <kbd>c</kbd>{' '}
                {copied === card.id ? (
                  <span className="text-mem-long">copied</span>
                ) : copied === 'failed' ? (
                  <span className="text-mem-fresh">copy blocked</span>
                ) : (
                  'copy'
                )}
              </button>
              <button onClick={beginDrop} className="py-2 text-left transition-colors hover:text-ink sm:py-0">
                <kbd>d</kbd> drop
              </button>
            </div>
          </div>
        ) : !flipped ? (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-3">
            {/* Recall mode is on but this card is not being typed. Say which of the two reasons
                it is, rather than silently reverting to the other flow. */}
            {recall && (
              <span className="w-full text-ink-4">
                {bypass ?? 'No reference answer to grade against — this one is yours to judge.'}
              </span>
            )}
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
            {/* What you typed, and what the machine made of it.

                Shown in full rather than summarised into a number. The whole reason this mode
                is propose-and-confirm is that the grader is new and unproven, and you cannot
                tell whether a grade was right without seeing the reasoning that produced it. */}
            {verdict && (
              <div className="space-y-3 border-l-2 border-ink-4 pl-4">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-[0.6875rem] uppercase tracking-[0.18em] text-ink-3">
                    Graded
                  </span>
                  <span className="text-sm text-ink">{RATING_LABELS[verdict.rating]}</span>
                  <span className="font-mono text-[0.625rem] tabular-nums text-ink-4">
                    {verdict.model} · {(verdict.latency_ms / 1000).toFixed(1)}s
                  </span>
                </div>
                <p className="text-sm leading-relaxed text-ink-2">{verdict.verdict}</p>
                {verdict.missing && (
                  <p className="text-xs leading-relaxed text-ink-3">
                    <span className="text-ink-4">missing — </span>
                    {verdict.missing}
                  </p>
                )}
                {typed.trim() && (
                  <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink-4">
                    <span className="uppercase tracking-[0.14em]">you typed</span> — {typed.trim()}
                  </p>
                )}
              </div>
            )}

            {/* The grader could not be reached, or you waved it off. Say which. */}
            {bypass && !verdict && (
              <p className="border-l-2 border-ink-4 pl-4 text-xs leading-relaxed text-ink-3">
                {bypass}
              </p>
            )}

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
                // The machine's pick, until you have picked something yourself. It is a
                // suggestion with a dotted outline, not a selection — nothing has been written.
                const proposed = !chosen && verdict?.rating === r;
                return (
                <button
                  key={r}
                  onClick={() => void gradeCard(r)}
                  disabled={busy}
                  className={`group rounded border py-4 transition-colors active:bg-surface disabled:opacity-40 ${
                    chosen
                      ? 'border-ink bg-surface'
                      : proposed
                        ? 'border-dashed border-ink-2 bg-surface'
                        : 'border-ink-4 hover:border-ink-2'
                  }`}
                >
                  <div
                    className={`text-sm ${chosen || proposed ? 'text-ink' : 'text-ink-2 group-hover:text-ink'}`}
                  >
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
              {verdict && !given[card.id] ? (
                <button onClick={acceptVerdict} className="py-2 text-left transition-colors hover:text-ink sm:py-0">
                  <kbd>↵</kbd> accept {RATING_LABELS[verdict.rating]}
                </button>
              ) : null}
              <span className="hidden sm:inline">
                <kbd>1</kbd>–<kbd>4</kbd>{' '}
                {given[card.id] ? 'change grade' : verdict ? 'override' : 'grade'}
              </span>
              <button onClick={startEditing} className="py-2 text-left transition-colors hover:text-ink sm:py-0">
                <kbd>e</kbd> edit
              </button>
              <button
                onClick={() => void explainCard()}
                disabled={!explainer.available || explaining || Boolean(explanations[card.id])}
                title={explainer.available ? undefined : (explainer.reason ?? undefined)}
                className="py-2 text-left transition-colors hover:text-ink disabled:opacity-40 sm:py-0"
              >
                <kbd>?</kbd> explain
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
