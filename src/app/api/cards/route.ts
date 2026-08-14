import { NextResponse } from 'next/server';
import { newCardState } from '@/lib/fsrs';
import { supabase } from '@/lib/supabase';
import { ANGLES, CARD_TYPES, type Angle, type CardType } from '@/lib/types';
import { parseNote, vaultRoot } from '@/scanner/vault';
import path from 'node:path';

async function handWritten(body: {
  note_path?: string;
  angle?: Angle;
  type?: CardType;
  front: string;
  back?: string | null;
  cloze_text?: string | null;
  context?: string | null;
}) {
  const db = supabase();

  // Standalone: no note, no tags, no deck derived from a folder.
  if (!body.note_path) {
    const angle: Angle = body.angle && ANGLES.includes(body.angle) ? body.angle : 'fact';
    const type: CardType = body.type && CARD_TYPES.includes(body.type) ? body.type : 'qa';

    const { data: card, error } = await db
      .from('cards')
      .insert({
        note_id: null,
        type,
        angle,
        front: body.front.trim(),
        back: body.back?.trim() || null,
        cloze_text: body.cloze_text?.trim() || null,
        context: body.context?.trim() || null,
        tags: [],
        deck: 'hand-written',
        status: 'active',
        authored_by: 'human',
        approved_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await db.from('card_states').insert(newCardState(card.id as string));
    return NextResponse.json({ ok: true, id: card.id });
  }

  const parsed = await parseNote(path.join(vaultRoot(), body.note_path), vaultRoot());

  const { data: note, error: noteError } = await db
    .from('notes')
    .upsert(
      {
        path: parsed.path,
        title: parsed.title,
        folder: parsed.folder,
        subfolder: parsed.subfolder,
        content: parsed.content,
        content_hash: parsed.contentHash,
        frontmatter: parsed.frontmatter,
        wikilinks: parsed.wikilinks,
        embeds: parsed.embeds,
        word_count: parsed.wordCount,
        is_stub: parsed.isStub,
        mtime: parsed.mtime.toISOString(),
        deleted_at: null,
      },
      { onConflict: 'path' },
    )
    .select('id')
    .single();
  if (noteError) return NextResponse.json({ error: noteError.message }, { status: 500 });

  const angle: Angle = body.angle && ANGLES.includes(body.angle) ? body.angle : 'fact';
  const type: CardType = body.type && CARD_TYPES.includes(body.type) ? body.type : 'qa';
  const tags = [parsed.folder, ...(parsed.subfolder?.split('/') ?? [])].map((t) =>
    t.toLowerCase().replace(/\s+/g, '-'),
  );

  const { data: card, error } = await db
    .from('cards')
    .insert({
      note_id: note.id as string,
      type,
      angle,
      front: body.front.trim(),
      back: body.back?.trim() || null,
      cloze_text: body.cloze_text?.trim() || null,
      context: body.context?.trim() || null,
      tags,
      deck: parsed.folder,
      status: 'active',
      authored_by: 'human',
      approved_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await db.from('card_states').insert(newCardState(card.id as string));
  return NextResponse.json({ ok: true, id: card.id });
}

/**
 * Write a card by hand for an approved target.
 *
 * This is the path the queue nudges toward. Constructing a prompt is itself a form of
 * elaborative encoding — the reason self-authored decks outperform downloaded ones — and
 * auto-generation forfeits it. Making the human-written card the default gesture, with the
 * model's candidates one keypress away as a fallback, recovers most of that while still solving
 * the blank page that left this vault at zero cards for eighteen months.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    target_id?: string;
    /** Alternative to target_id: write a card straight against a note, from the Cards view. */
    note_path?: string;
    angle?: Angle;
    type?: CardType;
    front: string;
    back?: string | null;
    cloze_text?: string | null;
    context?: string | null;
  };

  if (!body.front?.trim()) {
    return NextResponse.json({ error: 'A prompt is required.' }, { status: 400 });
  }

  // Hand-written. Either attached to a note, or standalone — something worth remembering that
  // never came from the vault.
  if (!body.target_id) {
    return handWritten(body);
  }

  const type: CardType = body.type && CARD_TYPES.includes(body.type) ? body.type : 'qa';
  const db = supabase();

  const { data: target, error: loadError } = await db
    .from('targets')
    .select('id, note_id, angle, excerpt, source_block_hash, notes!inner(folder, subfolder)')
    .eq('id', body.target_id)
    .single();
  if (loadError || !target) {
    return NextResponse.json({ error: 'Target not found' }, { status: 404 });
  }

  const note = target.notes as unknown as { folder: string; subfolder: string | null };
  const angle = target.angle as Angle;
  if (!ANGLES.includes(angle)) {
    return NextResponse.json({ error: 'Target has an unknown angle' }, { status: 400 });
  }

  const tags = [note.folder, ...(note.subfolder?.split('/') ?? [])].map((t) =>
    t.toLowerCase().replace(/\s+/g, '-'),
  );

  const { data: card, error: insertError } = await db
    .from('cards')
    .insert({
      target_id: target.id as string,
      note_id: target.note_id as string,
      type,
      angle,
      front: body.front.trim(),
      back: body.back?.trim() || null,
      context: body.context?.trim() || null,
      tags,
      deck: note.folder,
      status: 'active',
      authored_by: 'human',
      source_excerpt: target.excerpt as string,
      source_block_hash: target.source_block_hash as string | null,
      approved_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  await db.from('card_states').insert(newCardState(card.id as string));

  // The remaining drafts for this target were not chosen. Retire them so they don't linger in
  // the queue, and record why — an unused draft next to a hand-written one is a data point about
  // where the model's instinct diverges from Joseph's.
  const { data: discarded } = await db
    .from('cards')
    .select('id, front')
    .eq('target_id', target.id as string)
    .eq('status', 'proposed');

  if (discarded?.length) {
    await db
      .from('cards')
      .update({ status: 'retired', reject_reason: 'superseded by hand-written card' })
      .eq('target_id', target.id as string)
      .eq('status', 'proposed');

    await db.from('extraction_feedback').insert(
      discarded.map((d) => ({
        target_id: target.id as string,
        card_id: d.id as string,
        kind: 'card_edited',
        original: d.front as string,
        corrected: body.front.trim(),
      })),
    );
  }

  return NextResponse.json({ ok: true, id: card.id });
}
