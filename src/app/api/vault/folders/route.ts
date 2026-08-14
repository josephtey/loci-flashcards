import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { vaultStatus } from '@/lib/environment';
import { vaultRoot } from '@/scanner/vault';

/**
 * The folders you can scope a sync to.
 *
 * Hard-limited to `Ever Green Learnings`. The other vault roots hold notes that aren't meant to
 * become cards, and offering them as options invites a very expensive mistake — so the filter
 * lists what's inside one folder rather than letting you pick any folder at all.
 */
const ROOT_FOLDER = 'Ever Green Learnings';

export async function GET() {
  const vault = await vaultStatus();
  if (!vault.available) {
    return NextResponse.json({ error: vault.reason }, { status: 503 });
  }

  const base = path.join(vaultRoot(), ROOT_FOLDER);

  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (e) {
    return NextResponse.json(
      { root: ROOT_FOLDER, folders: [], error: e instanceof Error ? e.message : String(e) },
      { status: 200 },
    );
  }

  const folders = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map(async (e) => {
        const inner = await readdir(path.join(base, e.name), { withFileTypes: true }).catch(
          () => [],
        );
        return {
          name: e.name,
          path: `${ROOT_FOLDER}/${e.name}`,
          notes: inner.filter((f) => f.isFile() && f.name.endsWith('.md')).length,
          subfolders: inner.filter((f) => f.isDirectory() && !f.name.startsWith('.')).length,
        };
      }),
  );

  return NextResponse.json({
    root: ROOT_FOLDER,
    folders: folders.sort((a, b) => a.name.localeCompare(b.name)),
  });
}
