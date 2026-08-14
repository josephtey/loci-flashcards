import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';

export interface ParsedNote {
  path: string; // relative to vault root, POSIX separators
  title: string;
  folder: string;
  subfolder: string | null;
  content: string;
  contentHash: string;
  frontmatter: Record<string, unknown>;
  wikilinks: string[];
  embeds: string[];
  wordCount: number;
  isStub: boolean;
  mtime: Date;
}

/** Below this, a note is a placeholder rather than a thought. `Why should we model DNA?.md` is 17 bytes. */
const STUB_WORD_THRESHOLD = 25;

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function vaultRoot(): string {
  const root = process.env.VAULT_PATH;
  if (!root) throw new Error('VAULT_PATH is not set. Add it to .env.local.');
  return root;
}

export function vaultFolders(): string[] {
  return (process.env.VAULT_FOLDERS ?? 'Ever Green Learnings,Ever Green Notes')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
}

async function walk(dir: string, acc: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc; // folder configured but absent — reported by the caller as zero notes
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

/**
 * Extract [[wikilinks]] and ![[embeds]] separately.
 *
 * Embeds matter because they usually mean an image, and content that lives only in an image is
 * content the extractor must not guess at. Aliases (`[[Note|shown text]]`) and block references
 * (`[[Note#^abc]]`) resolve to the note title.
 */
export function extractLinks(content: string): { wikilinks: string[]; embeds: string[] } {
  const wikilinks = new Set<string>();
  const embeds = new Set<string>();
  const re = /(!?)\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const target = m[2].split('|')[0].split('#')[0].trim();
    if (!target) continue;
    (m[1] === '!' ? embeds : wikilinks).add(target);
  }
  return { wikilinks: [...wikilinks], embeds: [...embeds] };
}

export async function parseNote(absPath: string, root: string): Promise<ParsedNote> {
  const raw = await readFile(absPath, 'utf8');
  const info = await stat(absPath);
  const parsed = matter(raw);
  const content = parsed.content.trim();

  const rel = path.relative(root, absPath).split(path.sep).join('/');
  const [folder, ...rest] = rel.split('/');
  const subfolder = rest.length > 1 ? rest.slice(0, -1).join('/') : null;
  const title = path.basename(absPath, '.md');
  const words = content.split(/\s+/).filter(Boolean).length;
  const { wikilinks, embeds } = extractLinks(content);

  return {
    path: rel,
    title,
    folder,
    subfolder,
    content,
    contentHash: sha256(content),
    frontmatter: parsed.data as Record<string, unknown>,
    wikilinks,
    embeds,
    wordCount: words,
    isStub: words < STUB_WORD_THRESHOLD,
    mtime: info.mtime,
  };
}

export interface ScanResult {
  notes: ParsedNote[];
  unreadable: { path: string; error: string }[];
}

export async function scanVault(): Promise<ScanResult> {
  const root = vaultRoot();
  const notes: ParsedNote[] = [];
  const unreadable: { path: string; error: string }[] = [];

  for (const folder of vaultFolders()) {
    const files = await walk(path.join(root, folder));
    for (const file of files) {
      try {
        notes.push(await parseNote(file, root));
      } catch (err) {
        // Most likely cause: the vault lives in iCloud Drive and this file has been evicted to
        // a dataless placeholder. Reading normally materialises it, but that fails offline.
        unreadable.push({
          path: path.relative(root, file),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { notes, unreadable };
}
