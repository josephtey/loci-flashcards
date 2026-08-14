import { NextResponse } from 'next/server';
import { newCardState } from '@/lib/fsrs';
import { supabase } from '@/lib/supabase';
import { ANGLES, CARD_TYPES, type Angle, type CardType } from '@/lib/types';
import { splitBlocks } from '@/scanner/blocks';
import { parseNote, vaultRoot } from '@/scanner/vault';
import path from 'node:path';

interface Incoming {
  type: CardType;
  angle: Angle;
  front: string;
  back: string | null;
  cloze_text: string | null;
  context: string | null;
  source_excerpt: string;
  rationale: string;
  note_path: string;
}

/**
 * Persist the cards you kept.
 *
 * Each gets a target row alongside it, even though nothing proposed it — provenance is what the
 * Cards view and the drift detection are built on, and a card without one would be an orphan in
 * both. The note is upserted too, since you can quick-add from a note the scanner has never seen.
 */
export async function POST(req: Request) {
  const { cards } = (await req.json()) as { cards?: Incoming[] };
  if (!cards?.length) {
    return NextResponse.json({ error: 'Nothing to save.' }, { status: 400 });
  }

  const db = supabase();
  const root = vaultRoot();
  const noteIds = new Map<string, { id: string; folder: string; subfolder: string | null }>();
  let saved = 0;

  for (const c of cards) {
    if (!c.front?.trim()) continue;
    if (!ANGLES.includes(c.angle) || !CARD_TYPES.includes(c.type)) continue;

    // Resolve (and if necessary create) the note this came from.
    let note = noteIds.get(c.note_path);
    if (!note) {
      const parsed = await parseNote(path.join(root, c.note_path), root);
      const { data: row, error } = await db
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
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      note = { id: row.id as string, folder: parsed.folder, subfolder: parsed.subfolder };
      noteIds.set(c.note_path, note);

      // Keep the block snapshot current so a later edit can still detect drift on these cards.
      const blocks = splitBlocks(parsed.content);
      await db.from('note_blocks').delete().eq('note_id', note.id);
      if (blocks.length) {
        await db.from('note_blocks').insert(
          blocks.map((b) => ({
            note_id: note!.id,
            idx: b.idx,
            content: b.content,
            content_hash: b.contentHash,
            heading_path: b.headingPath,
            kind: b.kind,
          })),
        );
      }
    }

    const { data: target } = await db
      .from('targets')
      .insert({
        note_id: note.id,
        excerpt: c.source_excerpt || c.front,
        angle: c.angle,
        rationale: c.rationale || 'Added by hand from a direct request.',
        connects_to: [],
        status: 'approved',
      })
      .select('id')
      .single();

    const tags = [note.folder, ...(note.subfolder?.split('/') ?? [])].map((t) =>
      t.toLowerCase().replace(/\s+/g, '-'),
    );

    const { data: card, error: cardError } = await db
      .from('cards')
      .insert({
        target_id: (target?.id as string) ?? null,
        note_id: note.id,
        type: c.type,
        angle: c.angle,
        front: c.front.trim(),
        back: c.back?.trim() || null,
        cloze_text: c.cloze_text?.trim() || null,
        context: c.context?.trim() || null,
        tags,
        deck: note.folder,
        status: 'active',
        authored_by: 'model',
        source_excerpt: c.source_excerpt || null,
        approved_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (cardError) return NextResponse.json({ error: cardError.message }, { status: 500 });

    await db.from('card_states').insert(newCardState(card.id as string));
    saved++;
  }

  return NextResponse.json({ ok: true, saved });
}
