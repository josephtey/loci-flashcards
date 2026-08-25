import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import type { CardRow } from '@/lib/types';

/**
 * Explain a card's concept in plain language, for the moment self-grading turns into "I don't
 * actually know what this means." Haiku rather than the extraction/grading model: this is a
 * short, ungraded aside — cost and latency matter more than the last mile of quality.
 *
 * Same shape as `/api/grade`: the card is re-read server-side rather than trusted from the
 * request, and every failure returns 200 with `ok: false` so a missing key degrades the button
 * instead of breaking the review screen.
 */

let cachedClient: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!cachedClient) cachedClient = new Anthropic();
  return cachedClient;
}

const MODEL = 'claude-haiku-4-5';

export async function POST(req: Request) {
  const body = (await req.json()) as { cardId?: string };
  if (!body.cardId) {
    return NextResponse.json({ error: 'cardId is required' }, { status: 400 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ ok: false, reason: 'ANTHROPIC_API_KEY is not set.' });
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
  const front = card.cloze_text ?? card.front;
  const back = card.back ?? '';

  try {
    const message = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 300,
      system:
        "You explain a flashcard's concept to someone who is stuck on it, not someone who already " +
        'knows it. Two or three short sentences, plain language, no restating the question. If the ' +
        'card has a reference answer, ground the explanation in it rather than contradicting it. ' +
        'No markdown headers, no bullet lists — prose only.',
      messages: [
        {
          role: 'user',
          content: [
            `Card front: ${front}`,
            back ? `Card back: ${back}` : null,
            card.context ? `Context: ${card.context}` : null,
            '',
            'Explain the concept this card is testing.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });

    if (message.stop_reason === 'refusal') {
      return NextResponse.json({ ok: false, reason: 'The model declined to explain this one.' });
    }

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    if (!text) {
      return NextResponse.json({ ok: false, reason: 'No explanation came back.' });
    }

    return NextResponse.json({ ok: true, explanation: text, model: MODEL });
  } catch (err) {
    console.error('explain failed:', err);
    return NextResponse.json({
      ok: false,
      reason: err instanceof Error ? err.message : 'The explainer could not be reached.',
    });
  }
}
