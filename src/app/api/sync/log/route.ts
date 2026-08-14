import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

/**
 * Every generation, with the diff it read and what it produced.
 *
 * Ordered newest first. The diff text is the point: a run's card count tells you it worked, and
 * the source it worked from tells you whether it worked *well*.
 */
export async function GET() {
  const db = supabase();

  const { data: runs } = await db
    .from('scan_runs')
    .select(
      'id, started_at, finished_at, status, scope, request, targets_proposed, cards_proposed, model, error',
    )
    .order('started_at', { ascending: false })
    .limit(30);

  if (!runs?.length) return NextResponse.json({ runs: [] });

  const { data: noteRows } = await db
    .from('run_notes')
    .select('scan_run_id, note_title, note_path, kind, diff_text, words, targets_created, cards_created, skipped_reason')
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
    runs: runs.map((r) => ({ ...r, notes: byRun.get(r.id as string) ?? [] })),
  });
}
