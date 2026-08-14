import { supabase } from '../lib/supabase';
import { splitBlocks, diffBlocks, type Block, type BlockDiff } from './blocks';
import { scanVault, type ParsedNote } from './vault';

export interface NoteChange {
  noteId: string;
  note: ParsedNote;
  kind: 'new' | 'changed';
  blocks: Block[];
  diff: BlockDiff;
  /**
   * Accept this note's new text as the snapshot — call it once the note has been extracted from.
   *
   * Held back deliberately. Committing every snapshot before extraction begins means a run that
   * is cancelled or crashes halfway leaves the notes it never reached looking already-read, and
   * the next sync passes over them in silence. Deferring it makes an interrupted run resumable:
   * whatever wasn't finished is still, correctly, a pending change.
   */
  commit: () => Promise<void>;
}

export interface SyncResult {
  changes: NoteChange[];
  scanned: number;
  unchanged: number;
  deleted: string[];
  unreadable: { path: string; error: string }[];
}

export interface SyncOptions {
  /**
   * Restrict the walk to paths containing any of these fragments, e.g.
   * `["Biotech + Pharma", "Modeling Biology"]`. Matching on a path fragment rather than a full
   * folder path means you can name a leaf folder without spelling out its ancestors.
   */
  only?: string[];
  /**
   * Exact vault-relative paths to extract from, e.g. from the manual picker. Unlike `only`, which
   * matches path fragments, these are the precise notes and nothing else. Implies `force`, since
   * asking for a specific note means you want it re-read whether or not it changed.
   */
  paths?: string[];
  /**
   * Treat every in-scope note as changed, whatever the snapshot says.
   *
   * The snapshot is written before extraction runs, so a crashed or interrupted extraction leaves
   * the notes looking up-to-date and the retry does nothing. This is the escape hatch — also what
   * you want after editing the extraction prompts, when the vault hasn't changed but the output
   * would.
   */
  force?: boolean;
  /**
   * Compute the diff without writing anything.
   *
   * The snapshot is normally committed before extraction runs, which is fine for a scan but wrong
   * for a preview: showing you what changed should not itself mark it as seen. Nothing here
   * touches the database.
   */
  preview?: boolean;
}

/**
 * The diff engine.
 *
 * Rather than lean on git, this keeps its own snapshot: `notes.content` plus a `note_blocks` row
 * per semantic chunk. That's the whole mechanism — compare content hashes to find changed notes,
 * then compare block hashes within them to find which parts moved. Storing the full previous
 * text is what lets the approval queue show a real before/after alongside each proposal, and the
 * whole vault's markdown is well under a megabyte, so it costs nothing.
 *
 * Deletions are soft. A note that disappears from the vault marks its cards `needs_rewrite`
 * rather than dropping them — the cards may still be worth keeping even when their source is
 * gone, and that's Joseph's call, not the scanner's.
 */
export async function syncVault(opts: SyncOptions = {}): Promise<SyncResult> {
  const db = supabase();
  const scan = await scanVault();
  const unreadable = scan.unreadable;
  const exact = new Set(opts.paths?.filter(Boolean) ?? []);
  const scopes = opts.only?.filter(Boolean) ?? [];
  const scoped = exact.size > 0 || scopes.length > 0;
  const force = opts.force || exact.size > 0;

  const notes = exact.size
    ? scan.notes.filter((n) => exact.has(n.path))
    : scopes.length
      ? scan.notes.filter((n) => scopes.some((s) => n.path.includes(s)))
      : scan.notes;

  const { data: existing, error } = await db
    .from('notes')
    .select('id, path, content, content_hash, deleted_at');
  if (error) throw new Error(`Failed to read notes: ${error.message}`);

  const byPath = new Map((existing ?? []).map((row) => [row.path as string, row]));
  const seen = new Set<string>();
  const changes: NoteChange[] = [];
  let unchanged = 0;

  for (const note of notes) {
    seen.add(note.path);
    const prior = byPath.get(note.path);

    if (!force && prior && prior.content_hash === note.contentHash && !prior.deleted_at) {
      unchanged++;
      continue;
    }

    const blocks = splitBlocks(note.content);
    // Forcing means re-extracting the whole note, so compare against nothing.
    const priorBlocks = prior && !force ? splitBlocks(prior.content as string) : [];
    const diff = diffBlocks(priorBlocks, blocks);

    // A row with no content hash is a note that was seen but never committed — an interrupted
    // run. It is still new as far as extraction is concerned.
    const kind: 'new' | 'changed' = prior?.content_hash ? 'changed' : 'new';

    if (opts.preview) {
      changes.push({
        noteId: (prior?.id as string) ?? '',
        note,
        kind,
        blocks,
        diff,
        commit: async () => {},
      });
      continue;
    }

    const row = {
      path: note.path,
      title: note.title,
      folder: note.folder,
      subfolder: note.subfolder,
      // Deliberately the *old* text: see NoteChange.commit.
      content: (prior?.content as string) ?? '',
      content_hash: (prior?.content_hash as string) ?? '',
      frontmatter: note.frontmatter,
      wikilinks: note.wikilinks,
      embeds: note.embeds,
      word_count: note.wordCount,
      is_stub: note.isStub,
      mtime: note.mtime.toISOString(),
      last_changed_at: new Date().toISOString(),
      deleted_at: null,
    };

    const { data: saved, error: upsertError } = await db
      .from('notes')
      .upsert(row, { onConflict: 'path' })
      .select('id')
      .single();
    if (upsertError) throw new Error(`Failed to upsert ${note.path}: ${upsertError.message}`);

    const noteId = saved.id as string;

    const commit = async () => {
      await db
        .from('notes')
        .update({ content: note.content, content_hash: note.contentHash })
        .eq('id', noteId);

      // Replace the block snapshot wholesale. Blocks carry no state of their own — targets keep a
      // `source_block_hash` rather than a foreign key to a row that churns on every edit.
      await db.from('note_blocks').delete().eq('note_id', noteId);
      if (blocks.length) {
        const { error: blockError } = await db.from('note_blocks').insert(
          blocks.map((b) => ({
            note_id: noteId,
            idx: b.idx,
            content: b.content,
            content_hash: b.contentHash,
            heading_path: b.headingPath,
            kind: b.kind,
          })),
        );
        if (blockError)
          throw new Error(`Failed to write blocks for ${note.path}: ${blockError.message}`);
      }

      // A target whose source text no longer exists is stale — its card may be too.
      if (diff.removedHashes.length) {
        await db
          .from('targets')
          .update({ status: 'superseded' })
          .eq('note_id', noteId)
          .eq('status', 'pending')
          .in('source_block_hash', diff.removedHashes);

        await db
          .from('cards')
          .update({ status: 'needs_rewrite' })
          .eq('note_id', noteId)
          .eq('status', 'active')
          .in('source_block_hash', diff.removedHashes);
      }
    };

    changes.push({ noteId, note, kind, blocks, diff, commit });
  }

  // A scoped run only looked at part of the vault, so "absent from the walk" doesn't mean
  // "deleted" — skip the sweep entirely rather than soft-deleting everything out of scope.
  const deleted: string[] = [];
  for (const [path, row] of scoped || opts.preview ? [] : byPath) {
    if (seen.has(path) || row.deleted_at) continue;
    deleted.push(path);
    await db
      .from('notes')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', row.id as string);
    await db
      .from('cards')
      .update({ status: 'needs_rewrite' })
      .eq('note_id', row.id as string)
      .eq('status', 'active');
  }

  return { changes, scanned: notes.length, unchanged, deleted, unreadable };
}
