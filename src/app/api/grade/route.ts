import { NextResponse } from 'next/server';
import { gradeAnswer, warm } from '@/lib/grader';
import { gradable } from '@/lib/grading';
import { supabase } from '@/lib/supabase';
import type { CardRow } from '@/lib/types';

/**
 * Grade one typed answer.
 *
 * The card is re-read from the database rather than taken from the request. The client already
 * has the front and back on screen, so trusting it would be no faster — and it would mean the
 * grade was computed against whatever the browser said the answer was, which is not a property
 * you want in the log you intend to re-fit a scheduler from.
 *
 * Every failure here returns 200 with `ok: false` and a reason. A grader that cannot be reached
 * is a degraded session, not a broken one: the review screen falls back to self-grading and the
 * card is still answerable. Returning a 4xx/5xx would make the browser console look like the app
 * is on fire when the actual situation is "the laptop's model server is asleep".
 */
export async function POST(req: Request) {
  const body = (await req.json()) as { cardId?: string; answer?: string; warm?: boolean };

  // Fired when a typing session opens, to pay the model's load time before the first card is
  // answered rather than during it.
  if (body.warm) {
    await warm();
    return NextResponse.json({ ok: true });
  }

  if (!body.cardId || typeof body.answer !== 'string') {
    return NextResponse.json({ error: 'cardId and answer are required' }, { status: 400 });
  }

  const { data, error } = await supabase()
    .from('cards')
    .select('type, front, back, cloze_text, context, angle')
    .eq('id', body.cardId)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: 'No such card' }, { status: 404 });
  }

  const card = data as unknown as Pick<
    CardRow,
    'type' | 'front' | 'back' | 'cloze_text' | 'context' | 'angle'
  >;

  if (!gradable(card)) {
    return NextResponse.json({
      ok: false,
      reason: 'This card has no reference answer — grade it yourself.',
    });
  }

  try {
    return NextResponse.json({ ok: true, ...(await gradeAnswer(card, body.answer)) });
  } catch (err) {
    console.error('grade failed:', err);
    return NextResponse.json({
      ok: false,
      reason: err instanceof Error ? err.message : 'The grader could not be reached.',
    });
  }
}
