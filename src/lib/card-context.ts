import { hasCloze, renderCloze } from './cloze';
import { ANGLE_DESCRIPTIONS, type CardRow } from './types';

/**
 * A card as a block of markdown you can paste into a chat.
 *
 * The review screen deliberately shows you a card and then gets out of the way — there is nowhere
 * in it to ask "wait, why is that true?", and the built-in explain action answers one question
 * rather than starting a conversation. This is the escape hatch: everything the card knows about
 * itself, in a form another model can read, so the conversation happens where conversations are
 * good.
 *
 * Markdown rather than prose or JSON: chat models read the headings as structure, and a person
 * pasting it can still see at a glance what they are handing over.
 *
 * Client-safe, and it takes a plain card shape rather than a query result so the review screen
 * and anything else can share it.
 */
type CopyableCard = Pick<
  CardRow,
  'type' | 'angle' | 'front' | 'back' | 'cloze_text' | 'context' | 'tags' | 'source_excerpt'
> &
  Partial<Pick<CardRow, 'id'>> & {
    note_title?: string | null;
    note_path?: string | null;
    reps?: number;
    lapses?: number;
  };

export function cardContext(card: CopyableCard): string {
  const isCloze = card.type === 'cloze' && hasCloze(card.cloze_text);
  // The same derivation the review screen uses for its two faces, so what you copy is what you
  // were looking at — a cloze pasted as its raw `{{c1::...}}` source would be a puzzle for the
  // reader rather than a question.
  const question = isCloze ? renderCloze(card.cloze_text!, false) : card.front;
  const answer = isCloze ? renderCloze(card.cloze_text!, true) : card.back;

  const out: string[] = [
    card.note_title
      ? `Flashcard from my notes — ${card.note_title}`
      : 'Flashcard from my notes',
    '',
    '**Question**',
    question,
  ];

  if (answer?.trim()) out.push('', '**Answer**', answer.trim());

  // Background the review screen only shows after the reveal. Worth carrying: it is usually the
  // half that makes the answer make sense.
  if (card.context?.trim()) out.push('', '**Context**', card.context.trim());

  // The passage the card was written from. The most useful thing in here for a follow-up, since
  // it is the only part that is my own words rather than the card's compression of them.
  if (card.source_excerpt?.trim()) {
    out.push('', '**From the source note**', `> ${card.source_excerpt.trim().replace(/\n/g, '\n> ')}`);
  }

  const meta: string[] = [`angle: ${card.angle} — ${ANGLE_DESCRIPTIONS[card.angle]}`];
  if (card.note_path) meta.push(`source: ${card.note_path}`);
  if (card.tags?.length) meta.push(`tags: ${card.tags.join(', ')}`);
  // Only worth saying once there is a history to describe. "0 reviews, 0 lapses" is noise, and a
  // card you keep failing is context for why you are asking.
  if (card.reps) {
    meta.push(`reviewed ${card.reps}×${card.lapses ? `, forgotten ${card.lapses}×` : ''}`);
  }
  out.push('', ...meta.map((m) => `_${m}_`));

  return out.join('\n');
}
