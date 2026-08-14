import { NextResponse } from 'next/server';
import {
  LAPSE_LIMIT,
  SCHEDULER_VERSION,
  SKIP_LIMIT,
  grade,
  rowToCard,
  skipUntil,
} from '@/lib/fsrs';
import { supabase } from '@/lib/supabase';
import type { CardStateRow, RatingValue, StillEndorse } from '@/lib/types';

/**
 * Record one review.
 *
 * The `reviews` insert is the load-bearing line in this file. It is append-only and it is the
 * asset — with the full log we can re-fit FSRS parameters to Joseph's own history later, or
 * replay everything through a different scheduler entirely. Storing only `next_due` would lock
 * the deck to today's weights forever.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json()) as {
    action: 'grade' | 'skip' | 'flag_bad' | 'drop' | 'regrade';
    rating?: RatingValue;
    still_endorse?: StillEndorse;
    duration_ms?: number;
    reason?: string;
  };
  const db = supabase();

  const { data: state, error: loadError } = await db
    .from('card_states')
    .select('*')
    .eq('card_id', id)
    .single();
  if (loadError || !state) {
    return NextResponse.json({ error: 'Card has no schedule' }, { status: 404 });
  }

  const current = state as unknown as CardStateRow;
  const before = rowToCard(current);
  const now = new Date();

  if (body.action === 'skip') {
    // Deferral with exponential backoff, never a delete. Letting people drop cards measurably
    // hurts learning (Kornell & Bjork 2008; Whitmer 2020), so the escape hatch has to be one
    // that always brings the card back.
    const skipCount = current.skip_count + 1;
    await db
      .from('card_states')
      .update({
        skip_count: skipCount,
        skipped_until: skipUntil(skipCount, now).toISOString(),
        updated_at: now.toISOString(),
      })
      .eq('card_id', id);

    // Three skips is Joseph telling us something about the card, not about his memory.
    if (skipCount >= SKIP_LIMIT) {
      await db.from('cards').update({ status: 'needs_rewrite' }).eq('id', id);
    }

    await db.from('reviews').insert({
      card_id: id,
      action: 'skip',
      state_before: before,
      duration_ms: body.duration_ms ?? null,
      scheduler: 'fsrs',
      scheduler_version: SCHEDULER_VERSION,
    });

    return NextResponse.json({ ok: true, skipped: true, routedToRewrite: skipCount >= SKIP_LIMIT });
  }

  if (body.action === 'drop') {
    // Dropping is how a bad card leaves the system now that there is no approval gate, and it
    // stays available for a card's whole life: some only reveal that they were never worth
    // keeping on the third encounter. The reason feeds the extractor either way.
    await db
      .from('cards')
      .update({ status: 'retired', reject_reason: body.reason ?? 'dropped in review' })
      .eq('id', id);

    const { data: card } = await db.from('cards').select('front, target_id').eq('id', id).single();

    await db.from('extraction_feedback').insert({
      card_id: id,
      target_id: (card?.target_id as string) ?? null,
      kind: 'card_rejected',
      reason: body.reason ?? null,
      original: (card?.front as string) ?? null,
    });

    await db.from('reviews').insert({
      card_id: id,
      action: 'drop',
      state_before: before,
      duration_ms: body.duration_ms ?? null,
      scheduler: 'fsrs',
      scheduler_version: SCHEDULER_VERSION,
    });

    return NextResponse.json({ ok: true, dropped: true });
  }

  if (body.action === 'flag_bad') {
    await db.from('cards').update({ status: 'needs_rewrite' }).eq('id', id);
    await db.from('reviews').insert({
      card_id: id,
      action: 'flag_bad',
      state_before: before,
      duration_ms: body.duration_ms ?? null,
      scheduler: 'fsrs',
      scheduler_version: SCHEDULER_VERSION,
    });
    await db.from('extraction_feedback').insert({ card_id: id, kind: 'card_flagged_bad' });
    return NextResponse.json({ ok: true, flagged: true });
  }

  if (!body.rating || body.rating < 1 || body.rating > 4) {
    return NextResponse.json({ error: 'rating must be 1-4' }, { status: 400 });
  }

  // Changing your mind about a grade you just gave. The schedule is recomputed from the state the
  // card was in *before* that grade, so a correction lands exactly where the right answer would
  // have. The original review still stands in the log — it is append-only, and "graded Good then
  // immediately corrected to Again" is itself a fact about the card worth keeping.
  let from = current;
  if (body.action === 'regrade') {
    const { data: last } = await db
      .from('reviews')
      .select('state_before')
      .eq('card_id', id)
      .eq('action', 'grade')
      .order('reviewed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (last?.state_before) {
      const b = last.state_before as Record<string, unknown>;
      from = {
        ...current,
        due: b.due as string,
        stability: b.stability as number | null,
        difficulty: b.difficulty as number | null,
        elapsed_days: (b.elapsed_days as number) ?? 0,
        scheduled_days: (b.scheduled_days as number) ?? 0,
        learning_steps: (b.learning_steps as number) ?? 0,
        reps: (b.reps as number) ?? 0,
        lapses: (b.lapses as number) ?? 0,
        state: (b.state as 0 | 1 | 2 | 3) ?? 0,
        last_review: (b.last_review as string | null) ?? null,
      };
    }
  }

  const { next, stateAfter } = grade(id, from, body.rating, now);

  await db
    .from('card_states')
    .update({
      ...next,
      // A successful review clears accumulated skips — the deferral did its job.
      skip_count: 0,
      skipped_until: null,
      updated_at: now.toISOString(),
    })
    .eq('card_id', id);

  await db.from('reviews').insert({
    card_id: id,
    action: 'grade',
    rating: body.rating,
    still_endorse: body.still_endorse ?? null,
    state_before: rowToCard(from),
    state_after: stateAfter,
    duration_ms: body.duration_ms ?? null,
    scheduler: 'fsrs',
    scheduler_version: SCHEDULER_VERSION,
  });

  // A prompt you keep forgetting is a prompt that needs refactoring, not more repetitions.
  if (next.lapses >= LAPSE_LIMIT) {
    await db.from('cards').update({ status: 'needs_rewrite' }).eq('id', id);
  }

  // "My view has shifted" on a claim card is a signal about the note, not the card. Flag the
  // source so it surfaces as something to rewrite in Obsidian.
  if (body.still_endorse === 'shifted' || body.still_endorse === 'no') {
    await db.from('extraction_feedback').insert({
      card_id: id,
      kind: 'card_flagged_bad',
      reason: `position ${body.still_endorse === 'no' ? 'abandoned' : 'shifted'} — source note needs revision`,
    });
  }

  return NextResponse.json({
    ok: true,
    due: next.due,
    lapses: next.lapses,
    routedToRewrite: next.lapses >= LAPSE_LIMIT,
  });
}
