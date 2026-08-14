import { NextResponse } from 'next/server';
import { renderDiff } from '@/scanner/blocks';
import { syncVault } from '@/scanner/sync';

export const maxDuration = 120;

/**
 * What a sync would pick up, without committing to it.
 *
 * Read-only: no snapshot is written, so looking does not count as having seen it. Run it twice
 * and you get the same answer.
 */
export async function GET(req: Request) {
  const only = new URL(req.url).searchParams.getAll('only').filter(Boolean);
  const sync = await syncVault({ preview: true, only: only.length ? only : undefined });

  const changes = sync.changes
    .filter((c) => !c.note.isStub)
    .map((c) => {
      const blocks = [...c.diff.added, ...c.diff.changed];
      const words = blocks
        .map((b) => b.content)
        .join(' ')
        .split(/\s+/)
        .filter(Boolean).length;
      return {
        path: c.note.path,
        title: c.note.title,
        folder: c.note.subfolder ?? c.note.folder,
        kind: c.kind,
        blocks: blocks.length,
        words,
        diff: renderDiff(c.diff),
      };
    })
    .sort((a, b) => b.words - a.words);

  return NextResponse.json({
    only,
    changes,
    scanned: sync.scanned,
    unchanged: sync.unchanged,
    skipped: sync.changes.filter((c) => c.note.isStub).length,
  });
}
