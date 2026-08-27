import { NextResponse } from 'next/server';
import { explainCard } from '@/lib/grader';
import { supabase } from '@/lib/supabase';
import type { CardRow } from '@/lib/types';

/**
 * Explain a card's concept, for the moment self-grading turns into "I don't actually know what
 * this means." Runs on whichever provider `config.provider` names — same switch as grading —
 * rather than a model hardcoded here.
 *
 * Same shape as `/api/grade`: the card is re-read server-side rather than trusted from the
 * request, and every failure returns 200 with `ok: false` so an unreachable provider degrades
 * the button instead of breaking the review screen.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as { cardId?: string };
  if (!body.cardId) {
    return NextResponse.json({ error: 'cardId is required' }, { status: 400 });
  }

  const { data, error } = await supabase()
    .from('cards')
    .select('front, back, cloze_text, context')
    .eq('id', body.cardId)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: 'No such card' }, { status: 404 });
  }

  const card = data as unknown as Pick<CardRow, 'front' | 'back' | 'cloze_text' | 'context'>;

  try {
    return NextResponse.json({ ok: true, ...(await explainCard(card)) });
  } catch (err) {
    console.error('explain failed:', err);
    return NextResponse.json({
      ok: false,
      reason: err instanceof Error ? err.message : 'The explainer could not be reached.',
    });
  }
}
