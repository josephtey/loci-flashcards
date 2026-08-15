import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

/**
 * Every generation, with the diff it read and what it produced.
 *
 * Ordered newest first. The diff text is the point: a run's card count tells you it worked, and
 * the source it worked from tells you whether it worked *well*.
 *
 * Both halves are optional at the schema level. `scope`/`request` and the whole `run_notes` table
 * arrive with migration 0005, and a select naming a column that doesn't exist fails the entire
 * query — which meant this returned an empty history rather than a partial one, and the History
 * tab looked broken when it was merely unmigrated. Each layer now degrades on its own.
 */
const CORE = 'id, started_at, finished_at, status, targets_proposed, cards_proposed, model, error';

export async function GET() {
  const db = supabase();

  const newest = (cols: string) =>
    db.from('scan_runs').select(cols).order('started_at', { ascending: false }).limit(30);

  // A dynamic select string defeats PostgREST's inferred row type, so the shape is asserted once
  // here rather than threaded through every read below.
  type Row = Record<string, unknown>;
  const first = await newest(`${CORE}, scope, request`);
  let runs = first.data as unknown as Row[] | null;
  // Without the migration the run list still works; it just can't say what it was scoped to.
  const unmigrated = Boolean(first.error?.message?.includes('column'));
  if (unmigrated) runs = (await newest(CORE)).data as unknown as Row[] | null;

  if (!runs?.length) return NextResponse.json({ runs: [], detailed: !unmigrated });

  const { data: noteRows } = await db
    .from('run_notes')
    .select(
      'scan_run_id, note_title, note_path, kind, diff_text, words, targets_created, cards_created, skipped_reason',
    )
    .in(
      'scan_run_id',
      runs.map((r) => r.id as string),
    )
    .order('cards_created', { ascending: false });

  const byRun = new Map<string, unknown[]>();
  for (const n of noteRows ?? []) {
    const list = byRun.get(n.scan_run_id as string) ?? [];
    list.push(n);
    byRun.set(n.scan_run_id as string, list);
  }

  return NextResponse.json({
    // False means the runs are listed but their per-note diffs aren't recorded yet.
    detailed: Boolean(noteRows),
    runs: runs.map((r) => ({ ...r, notes: byRun.get(r.id as string) ?? [] })),
  });
}
