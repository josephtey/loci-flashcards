import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

/**
 * What a scan actually produced, grouped by note.
 *
 * Cards are found through their target's `scan_run_id` — the run is the unit of "this batch",
 * and a card's provenance already points back to it, so nothing extra needs recording.
 *
 * `since` scopes this to the run you just started. Without it this returned the most recent
 * *completed* run, which is a comfortable lie: a scan that died on its first query left the last
 * good run's surviving cards on screen under the heading "Cards added", so a total failure
 * presented as a thin batch. A run that failed, or never started at all, has to say so.
 */
export async function GET(req: Request) {
  const db = supabase();
  const since = new URL(req.url).searchParams.get('since');

  let q = db
    .from('scan_runs')
    .select('id, started_at, finished_at, status, targets_proposed, cards_proposed, error');
  // A few seconds of slack: the client stamps the time it clicked, the scanner writes its row
  // after walking the vault, and those clocks are not the same clock.
  if (since) q = q.gte('started_at', new Date(new Date(since).getTime() - 15000).toISOString());
  else q = q.eq('status', 'completed');

  const { data: run } = await q.order('started_at', { ascending: false }).limit(1).maybeSingle();

  if (!run) {
    return NextResponse.json({
      run: null,
      notes: [],
      failed: Boolean(since),
      error: since
        ? 'The scanner never recorded a run. It exited before it could start — its output is in the scan log.'
        : null,
    });
  }

  if (run.status !== 'completed') {
    return NextResponse.json({
      run,
      notes: [],
      failed: true,
      error: (run.error as string) ?? `The run ended as "${run.status}".`,
    });
  }

  const { data: targets } = await db
    .from('targets')
    .select('id, note_id')
    .eq('scan_run_id', run.id as string);

  const targetIds = (targets ?? []).map((t) => t.id as string);
  if (!targetIds.length) return NextResponse.json({ run, notes: [] });

  const { data: cards } = await db
    .from('cards')
    .select('id, note_id, front, back, cloze_text, type, angle, target_id')
    .in('target_id', targetIds)
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  const noteIds = [...new Set((cards ?? []).map((c) => c.note_id as string).filter(Boolean))];
  const { data: notes } = await db.from('notes').select('id, title, subfolder, folder').in('id', noteIds);
  const byId = new Map((notes ?? []).map((n) => [n.id as string, n]));

  const grouped = new Map<string, { title: string; folder: string; cards: unknown[] }>();
  for (const c of cards ?? []) {
    const n = byId.get(c.note_id as string);
    const key = (c.note_id as string) ?? 'none';
    const g = grouped.get(key) ?? {
      title: (n?.title as string) ?? 'Written by hand',
      folder: (n?.subfolder as string) ?? (n?.folder as string) ?? '',
      cards: [],
    };
    g.cards.push(c);
    grouped.set(key, g);
  }

  return NextResponse.json({ run, notes: [...grouped.values()] });
}
