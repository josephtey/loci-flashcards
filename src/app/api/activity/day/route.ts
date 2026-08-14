import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { RATING_LABELS, type RatingValue } from '@/lib/types';

/**
 * What happened on one day: every card reviewed, and how it went.
 *
 * The graph square answers "did I show up"; this answers "and how did it go" — which is the more
 * useful question when a day looks unusually heavy or unusually poor.
 */
export async function GET(req: Request) {
  const date = new URL(req.url).searchParams.get('date');
  if (!date) return NextResponse.json({ error: 'date required' }, { status: 400 });

  const start = new Date(`${date}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const db = supabase();

  const { data: reviews } = await db
    .from('reviews')
    .select('id, card_id, rating, action, reviewed_at, state_before, duration_ms')
    .gte('reviewed_at', start.toISOString())
    .lt('reviewed_at', end.toISOString())
    .order('reviewed_at', { ascending: true });

  if (!reviews?.length) return NextResponse.json({ date, reviews: [] });

  const ids = [...new Set(reviews.map((r) => r.card_id as string))];
  const { data: cards } = await db
    .from('cards')
    .select('id, front, back, cloze_text, type, angle, note_id')
    .in('id', ids);
  const byId = new Map((cards ?? []).map((c) => [c.id as string, c]));

  const noteIds = [...new Set((cards ?? []).map((c) => c.note_id as string).filter(Boolean))];
  const { data: notes } = await db.from('notes').select('id, title').in('id', noteIds);
  const noteById = new Map((notes ?? []).map((n) => [n.id as string, n.title as string]));

  return NextResponse.json({
    date,
    reviews: reviews.map((r) => {
      const c = byId.get(r.card_id as string);
      const before = r.state_before as { reps?: number } | null;
      return {
        id: r.id,
        action: r.action,
        rating: r.rating,
        ratingLabel: r.rating ? RATING_LABELS[r.rating as RatingValue] : null,
        wasNew: !before?.reps,
        durationMs: r.duration_ms,
        at: r.reviewed_at,
        front: (c?.front as string) ?? '(deleted card)',
        back: (c?.back as string | null) ?? null,
        cloze_text: (c?.cloze_text as string | null) ?? null,
        type: (c?.type as string) ?? 'qa',
        angle: (c?.angle as string) ?? '',
        note: c?.note_id ? (noteById.get(c.note_id as string) ?? null) : null,
      };
    }),
  });
}
