import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { scanVault } from '@/scanner/vault';

export interface VaultNote {
  path: string;
  title: string;
  folder: string;
  subfolder: string | null;
  wordCount: number;
  isStub: boolean;
  mtime: string;
  /** Cards already in the deck or queue from this note — so you can see what's uncovered. */
  cards: number;
  /** Targets still awaiting triage. */
  pending: number;
}

/**
 * List every note in scope, annotated with how much of it is already carded.
 *
 * This reads the filesystem, so like the scanner it only works where the vault lives. The card
 * counts are the useful part: the picker's job is to answer "which of my notes has the system
 * barely touched", and a bare file tree can't.
 */
export async function GET() {
  const db = supabase();
  const { notes, unreadable } = await scanVault();

  const { data: noteRows } = await db.from('notes').select('id, path').is('deleted_at', null);
  const idByPath = new Map((noteRows ?? []).map((n) => [n.path as string, n.id as string]));

  const { data: cardRows } = await db
    .from('cards')
    .select('note_id')
    .in('status', ['proposed', 'active', 'suspended']);
  const cardsByNote = new Map<string, number>();
  for (const c of cardRows ?? []) {
    const id = c.note_id as string;
    cardsByNote.set(id, (cardsByNote.get(id) ?? 0) + 1);
  }

  const { data: targetRows } = await db.from('targets').select('note_id').eq('status', 'pending');
  const pendingByNote = new Map<string, number>();
  for (const t of targetRows ?? []) {
    const id = t.note_id as string;
    pendingByNote.set(id, (pendingByNote.get(id) ?? 0) + 1);
  }

  const out: VaultNote[] = notes
    .map((n) => {
      const id = idByPath.get(n.path);
      return {
        path: n.path,
        title: n.title,
        folder: n.folder,
        subfolder: n.subfolder,
        wordCount: n.wordCount,
        isStub: n.isStub,
        mtime: n.mtime.toISOString(),
        cards: id ? (cardsByNote.get(id) ?? 0) : 0,
        pending: id ? (pendingByNote.get(id) ?? 0) : 0,
      };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));

  return NextResponse.json({ notes: out, unreadable: unreadable.length });
}
