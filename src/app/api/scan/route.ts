import { spawn } from 'node:child_process';
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

/**
 * Kick off a vault scan from the UI — and see it, and stop it.
 *
 * The scan reads the vault off the local filesystem, so this only works where the app and the
 * vault live on the same machine — which is the point: `next dev` on the laptop. It spawns the
 * same `npm run scan` the CLI runs rather than doing the work inline, because a scan takes
 * minutes and a request shouldn't be holding it open. The client polls GET for progress.
 *
 * The database is the source of truth for "is something running", not this module's memory: a
 * dev-server reload wipes module state while the detached scan keeps going, and a scan started
 * from the terminal was never in this process at all. The pid on the row is what makes that
 * work — it's checkable (is it alive?) and actionable (kill it).
 */

let spawned: { pid: number; startedAt: number } | null = null;

/** Is this pid still a live process? Signal 0 tests for existence without delivering anything. */
function alive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface RunRow {
  id: string;
  pid: number | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  scope: string | null;
  request: string | null;
  notes_changed: number | null;
  targets_proposed: number | null;
  cards_proposed: number | null;
  error: string | null;
}

async function latestRun(): Promise<RunRow | null> {
  const { data } = await supabase()
    .from('scan_runs')
    .select(
      'id, pid, status, started_at, finished_at, scope, request, notes_changed, ' +
        'targets_proposed, cards_proposed, error',
    )
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as RunRow | null) ?? null;
}

export async function POST(req: Request) {
  const current = await latestRun();
  if (current?.status === 'running' && alive(current.pid)) {
    return NextResponse.json({ started: false, reason: 'already running' }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    paths?: string[];
    request?: string;
    only?: string[];
  };

  // A targeted run needs both halves — which notes, and what to look for in them. Without the
  // request it would silently degrade into a full sweep of those notes, which is a different
  // and much more expensive thing than what was asked for.
  if (body.paths?.length && !body.request?.trim()) {
    return NextResponse.json(
      { started: false, reason: 'a targeted run needs a request' },
      { status: 400 },
    );
  }

  // Args go through spawn's array form, never a shell — so a free-text instruction containing
  // quotes, newlines or `$` reaches the scanner intact and can't be interpreted as shell syntax.
  const args = ['run', 'scan', '--'];
  if (body.only?.length) args.push('--only', body.only.join(','));
  if (body.paths?.length) args.push('--paths', body.paths.join(','));
  if (body.request?.trim()) args.push('--request', body.request.trim());

  const child = spawn('npm', args, {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });

  spawned = { pid: child.pid ?? -1, startedAt: Date.now() };
  child.once('exit', () => {
    spawned = null;
  });
  child.unref();

  return NextResponse.json({ started: true, pid: child.pid });
}

export async function GET() {
  const db = supabase();
  const run = await latestRun();

  // A 'running' row whose process is gone is a scan that was killed or crashed before it could
  // close itself out. Reconcile it here rather than leaving a job that never ends on screen.
  let stale = false;
  if (run?.status === 'running' && !alive(run.pid)) {
    stale = true;
    await db
      .from('scan_runs')
      .update({
        status: 'cancelled',
        finished_at: new Date().toISOString(),
        error: run.error ?? 'stopped before finishing',
      })
      .eq('id', run.id);
  }

  const running = (run?.status === 'running' && !stale) || Boolean(spawned && !run);

  const { count: pending } = await db
    .from('targets')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');

  return NextResponse.json({
    running,
    // Between POST and the scanner writing its row there is a gap of a few seconds where nothing
    // is in the database yet; the spawn timestamp covers it so the clock starts when you clicked.
    startedAt: running ? (run?.started_at ?? new Date(spawned?.startedAt ?? Date.now()).toISOString()) : null,
    elapsedMs: running
      ? Date.now() - new Date(run?.started_at ?? spawned?.startedAt ?? Date.now()).getTime()
      : null,
    current: running ? run : null,
    lastRun: stale ? { ...run, status: 'cancelled' } : run,
    pendingTargets: pending ?? 0,
  });
}

/** Stop the scan that's in flight. */
export async function DELETE() {
  const run = await latestRun();
  const pids = new Set<number>();
  if (run?.status === 'running' && run.pid) pids.add(run.pid);
  // The npm wrapper is the process-group leader; killing the group takes the whole chain down,
  // where killing only the tsx process would leave npm hanging around.
  if (spawned?.pid && spawned.pid > 0) pids.add(-spawned.pid);

  let killed = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      killed++;
    } catch {
      /* already gone */
    }
  }

  if (run?.status === 'running') {
    await supabase()
      .from('scan_runs')
      .update({
        status: 'cancelled',
        finished_at: new Date().toISOString(),
        error: 'cancelled from the app',
      })
      .eq('id', run.id);
  }

  spawned = null;
  return NextResponse.json({ cancelled: killed > 0 || run?.status === 'running', killed });
}
