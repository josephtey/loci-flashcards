import { NextResponse } from 'next/server';
import { newCardState } from '@/lib/fsrs';
import { supabase } from '@/lib/supabase';

/**
 * Accept, edit, or reject one proposed card.
 *
 * `accept` is where a card enters the deck: status flips to active and a scheduling row appears.
 * Until then it has no schedule at all, which is what keeps unapproved output from ever reaching
 * a review session.
 */
/** Hard delete. Used from the Cards view, where "get rid of this" should mean exactly that. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = supabase();

  // Reviews and states cascade from the card row; feedback is kept but unlinked so the
  // extractor's record of what was rejected survives the card itself.
  await db.from('extraction_feedback').update({ card_id: null }).eq('card_id', id);
  const { error } = await db.from('cards').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json()) as {
    action: string;
    front?: string;
    back?: string | null;
    cloze_text?: string;
    reason?: string;
  };
  const db = supabase();

  const { data: card, error: loadError } = await db
    .from('cards')
    .select('id, front, back, cloze_text, authored_by, model_original, status')
    .eq('id', id)
    .single();
  if (loadError || !card) {
    return NextResponse.json({ error: 'Card not found' }, { status: 404 });
  }

  switch (body.action) {
    case 'accept': {
      const edited =
        (body.front !== undefined && body.front !== card.front) ||
        (body.back !== undefined && body.back !== card.back);

      const update: Record<string, unknown> = {
        status: 'active',
        approved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      if (edited) {
        update.front = body.front ?? card.front;
        update.back = body.back ?? card.back;
        update.authored_by = 'edited';
        // Keep the model's version. It's the training signal, and it's how we can tell later
        // whether editing actually improved retention or just felt productive.
        update.model_original = card.model_original ?? { front: card.front, back: card.back };
      }

      await db.from('cards').update(update).eq('id', id);
      await db.from('card_states').upsert(newCardState(id), { onConflict: 'card_id' });

      // The sibling drafts for this target weren't chosen. Retire them so they don't linger,
      // and record the pairing — a rejected draft next to the accepted one is a data point
      // about where the model's instinct diverges from Joseph's.
      const { data: target } = await db.from('cards').select('target_id').eq('id', id).single();
      if (target?.target_id) {
        const { data: siblings } = await db
          .from('cards')
          .select('id, front')
          .eq('target_id', target.target_id as string)
          .eq('status', 'proposed')
          .neq('id', id);

        if (siblings?.length) {
          await db
            .from('cards')
            .update({ status: 'retired', reject_reason: 'sibling draft chosen' })
            .eq('target_id', target.target_id as string)
            .eq('status', 'proposed')
            .neq('id', id);

          await db.from('extraction_feedback').insert(
            siblings.map((s) => ({
              card_id: s.id as string,
              kind: 'card_rejected',
              reason: 'another draft for the same target was preferred',
              original: s.front as string,
              corrected: (body.front ?? card.front) as string,
            })),
          );
        }
      }

      if (edited) {
        await db.from('extraction_feedback').insert({
          card_id: id,
          kind: 'card_edited',
          original: card.front as string,
          corrected: (body.front ?? card.front) as string,
        });
      }

      return NextResponse.json({ ok: true, edited });
    }

    case 'reject': {
      await db
        .from('cards')
        .update({ status: 'retired', reject_reason: body.reason ?? null })
        .eq('id', id);
      await db.from('extraction_feedback').insert({
        card_id: id,
        kind: 'card_rejected',
        reason: body.reason ?? null,
        original: card.front as string,
      });
      return NextResponse.json({ ok: true });
    }

    case 'edit': {
      // Fixing a card in place, mid-session. The model's version is preserved the first time it
      // is touched: it is the training signal for the extractor, and it is the only way to tell
      // later whether editing actually improved retention or merely felt productive.
      const update: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
        authored_by: card.authored_by === 'human' ? 'human' : 'edited',
        model_original: card.model_original ?? { front: card.front, back: card.back },
      };
      if (typeof body.front === 'string') update.front = body.front.trim();
      if (body.back !== undefined) update.back = body.back?.trim() || null;
      if (typeof body.cloze_text === 'string') update.cloze_text = body.cloze_text.trim() || null;

      const { error } = await db.from('cards').update(update).eq('id', id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      await db.from('extraction_feedback').insert({
        card_id: id,
        kind: 'card_edited',
        original: card.front as string,
        corrected: (body.front ?? card.front) as string,
      });

      return NextResponse.json({ ok: true });
    }

    case 'suspend': {
      await db.from('cards').update({ status: 'suspended' }).eq('id', id);
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${body.action}` }, { status: 400 });
  }
}
