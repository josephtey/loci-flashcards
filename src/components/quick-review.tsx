'use client';

import { useCallback, useEffect, useState } from 'react';
import { RichText } from '@/components/rich-text';
import { hasCloze, renderCloze } from '@/lib/cloze';
import type { QuickCard } from '@/lib/types';

export interface Draft extends QuickCard {
  note_path: string;
}

/**
 * Verify before saving.
 *
 * This is the one place cards are checked before they enter the deck. Everywhere else they go
 * straight in and get vetted on first review — but there you asked for a sweep and can afford to
 * meet a dud later. Here you asked a precise question and are standing right there, so the cheapest
 * moment to catch a bad answer is now.
 */
export function QuickReview({
  cards,
  skippedReason,
  onSave,
  onCancel,
}: {
  cards: Draft[];
  skippedReason: string | null;
  onSave: (kept: Draft[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [kept, setKept] = useState<Draft[]>([]);
  const [saving, setSaving] = useState(false);

  const card = cards[idx];
  const done = idx >= cards.length;

  const decide = useCallback(
    (keep: boolean) => {
      if (keep && card) setKept((k) => [...k, card]);
      setFlipped(false);
      setIdx((i) => i + 1);
    },
    [card],
  );

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await onSave(kept);
    } finally {
      setSaving(false);
    }
  }, [kept, onSave]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (saving) return;
      if (done) {
        if (e.key === 'Enter') {
          e.preventDefault();
          void save();
        }
        return;
      }
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        setFlipped((v) => !v);
      } else if (e.key === 'k' || e.key === 'a') {
        e.preventDefault();
        decide(true);
      } else if (e.key === 'd' || e.key === 'x') {
        e.preventDefault();
        decide(false);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [done, saving, decide, save, onCancel]);

  const isCloze = card && card.type === 'cloze' && hasCloze(card.cloze_text);
  const question = isCloze ? renderCloze(card.cloze_text!, false) : card?.front;
  const answer = isCloze ? renderCloze(card.cloze_text!, true) : card?.back;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/95 px-6 backdrop-blur-sm">
      <div className="rise flex w-full max-w-2xl flex-col">
        <div className="flex items-baseline justify-between text-xs text-ink-3">
          <span>{done ? 'Ready to add' : 'Check before adding'}</span>
          <span className="tabular-nums">
            {done ? `${kept.length} of ${cards.length} kept` : `${idx + 1} / ${cards.length}`}
          </span>
        </div>

        {done ? (
          <div className="mt-10 flex flex-col items-center gap-8 py-16">
            <p className="text-center text-sm leading-relaxed text-ink-2">
              {kept.length === 0
                ? 'Nothing kept. Nothing will be saved.'
                : `${kept.length} card${kept.length === 1 ? '' : 's'} will be added to your deck.`}
            </p>
            <div className="flex items-center gap-6">
              <button
                onClick={() => void save()}
                disabled={saving}
                className="rounded border border-ink-4 px-4 py-2 text-sm text-ink-2 transition-colors hover:border-ink-2 hover:text-ink disabled:opacity-40"
              >
                {saving ? 'Saving…' : kept.length ? `Add ${kept.length}` : 'Close'}
              </button>
              <button onClick={onCancel} className="text-xs text-ink-3 hover:text-ink">
                Discard all
              </button>
            </div>
          </div>
        ) : (
          <>
            <div
              onClick={() => setFlipped((v) => !v)}
              className="card mt-6 min-h-[16rem] cursor-pointer select-none px-8 py-10"
            >
              <RichText text={question ?? ''} className="text-xl font-light leading-snug" />
              {flipped && (
                <div className="rise">
                  <div className="my-6 h-px w-10 bg-ink-4" />
                  {answer ? (
                    <RichText text={answer} className="leading-relaxed text-ink-2" />
                  ) : (
                    <p className="text-sm text-ink-3">No answer — the value is being asked.</p>
                  )}
                  {card.context && <p className="mt-4 text-sm text-ink-3">{card.context}</p>}
                </div>
              )}
            </div>

            {flipped && (
              <div className="rise mt-4 border-l border-ink-4 pl-4">
                <p className="text-xs leading-relaxed text-ink-3">{card.rationale}</p>
                <p className="mt-2 font-mono text-[0.625rem] leading-relaxed text-ink-4">
                  {card.angle} · {card.note_path.split('/').pop()?.replace(/\.md$/, '')}
                </p>
                <p className="mt-2 text-xs italic leading-relaxed text-ink-4">
                  “{card.source_excerpt.slice(0, 240)}”
                </p>
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-ink-4 pt-5 text-xs text-ink-3">
              <span>
                <kbd>space</kbd> reveal
              </span>
              <button onClick={() => decide(true)} className="hover:text-ink">
                <kbd>k</kbd> keep
              </button>
              <button onClick={() => decide(false)} className="hover:text-ink">
                <kbd>d</kbd> drop
              </button>
              <button onClick={onCancel} className="ml-auto hover:text-ink">
                <kbd>esc</kbd> discard all
              </button>
            </div>
          </>
        )}

        {skippedReason && (
          <p className="mt-6 border-t border-ink-4 pt-4 text-xs leading-relaxed text-ink-4">
            {skippedReason}
          </p>
        )}
      </div>
    </div>
  );
}
