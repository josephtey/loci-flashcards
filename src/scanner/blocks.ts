import { sha256 } from './vault';

export type BlockKind = 'paragraph' | 'list' | 'heading' | 'code' | 'quote' | 'table' | 'image';

export interface Block {
  idx: number;
  content: string;
  contentHash: string;
  headingPath: string | null;
  kind: BlockKind;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const QUOTE = /^\s*>/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const IMAGE_ONLY = /^\s*!\[\[[^\]]+\]\]\s*$|^\s*!\[[^\]]*\]\([^)]+\)\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Split a note into semantic blocks.
 *
 * The unit matters: this is what the diff engine compares, so a block that is too fine makes
 * every reflow look like a change, and one that is too coarse re-proposes targets for text that
 * never moved. Consecutive list items group into one block deliberately — Joseph's technical
 * notes are largely numbered mechanisms, and the steps of a mechanism belong together.
 *
 * Note that the diff selects *targets*; it does not bound the context handed to the model. The
 * extractor always sees the whole note.
 */
export function splitBlocks(content: string): Block[] {
  const lines = content.split('\n');
  const blocks: Block[] = [];
  const headings: string[] = [];

  let buf: string[] = [];
  let kind: BlockKind = 'paragraph';
  let inFence = false;
  let fenceMarker = '';

  const headingPath = () => (headings.length ? headings.join(' > ') : null);

  const flush = () => {
    const text = buf.join('\n').trim();
    buf = [];
    if (!text) return;
    blocks.push({
      idx: blocks.length,
      content: text,
      contentHash: sha256(text),
      headingPath: headingPath(),
      kind,
    });
    kind = 'paragraph';
  };

  for (const line of lines) {
    // Fenced code is opaque — never split inside it, never reinterpret its contents.
    if (inFence) {
      buf.push(line);
      if (FENCE.test(line) && line.trim().startsWith(fenceMarker)) {
        inFence = false;
        flush();
      }
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      flush();
      inFence = true;
      fenceMarker = fence[1];
      kind = 'code';
      buf.push(line);
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      flush();
      const depth = heading[1].length;
      headings.length = Math.min(headings.length, depth - 1);
      headings[depth - 1] = heading[2].trim();
      kind = 'heading';
      buf.push(line);
      flush();
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    // Classify from the first line of a run; continuation lines inherit it.
    if (!buf.length) {
      if (IMAGE_ONLY.test(line)) kind = 'image';
      else if (LIST_ITEM.test(line)) kind = 'list';
      else if (QUOTE.test(line)) kind = 'quote';
      else if (TABLE_ROW.test(line)) kind = 'table';
      else kind = 'paragraph';
    }

    buf.push(line);
  }

  flush();
  return reindex(splitOversized(mergeAdjacentLists(blocks)));
}

/**
 * The largest a list block may be before it gets split along its outline.
 *
 * Roughly two hundred words — about two targets' worth. Small enough that an edit is localised to
 * the part that changed, large enough that a mechanism written as five steps stays intact, since
 * nothing under this size is ever split at all.
 */
const MAX_LIST_BLOCK = 1200;

/** Leading whitespace, with a tab counted as four columns so mixed indentation still sorts. */
function indentOf(line: string): number {
  const ws = /^[ \t]*/.exec(line)![0];
  return [...ws].reduce((n, c) => n + (c === '\t' ? 4 : 1), 0);
}

/** An outline item's own text, for use as breadcrumb context on its children. */
function labelOf(line: string): string {
  const text = line.replace(LIST_ITEM, '').trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/**
 * Break an oversized outline into one block per top-level item.
 *
 * A note written as a single nested outline — everything hanging off one or two root bullets, as
 * most of Joseph's technical notes are — is one uninterrupted list run, so merging leaves the
 * whole document as a single block. That looks harmless until you edit it: the entire note then
 * reads as one changed block, so adding a section on binding assays hands the extractor four
 * thousand words of already-covered material and asks it to find what is new. It re-proposes
 * targets across the lot, and provenance is no better — one hash covering most of the note means
 * any edit anywhere marks every card drawn from it as stale.
 *
 * Splitting descends indentation levels until the pieces are small enough, so the unit is
 * whatever level of the outline actually carries the structure, and each piece keeps its
 * ancestors as a breadcrumb path.
 */
function splitOutline(
  text: string,
  path: string | null,
  max: number,
): { content: string; path: string | null }[] {
  if (text.length <= max) return [{ content: text, path }];

  const lines = text.split('\n');
  const items = lines.filter((l) => l.trim() && LIST_ITEM.test(l));
  if (!items.length) return [{ content: text, path }];

  const outermost = Math.min(...items.map(indentOf));
  const groups: string[][] = [];
  let cur: string[] = [];
  for (const line of lines) {
    const startsItem = Boolean(line.trim()) && LIST_ITEM.test(line) && indentOf(line) === outermost;
    if (startsItem && cur.length) {
      groups.push(cur);
      cur = [];
    }
    cur.push(line);
  }
  if (cur.length) groups.push(cur);

  // A single root item wrapping the whole note carries no information on its own — adopt its text
  // as context and split the children instead, or nothing would ever divide.
  if (groups.length === 1) {
    const [head, ...rest] = groups[0];
    const body = rest.join('\n').trim();
    if (!body || !LIST_ITEM.test(head)) return [{ content: text, path }];
    const label = labelOf(head);
    const inner = splitOutline(body, path ? `${path} > ${label}` : label, max);
    // The root's own line rides with its first child. Using it only as a breadcrumb would drop it
    // from the text, and a breadcrumb is truncated — the sentence itself has to survive intact.
    if (inner.length) inner[0] = { ...inner[0], content: `${head.trim()}\n${inner[0].content}` };
    return inner;
  }

  return groups.flatMap((group) => {
    const chunk = group.join('\n').trim();
    if (!chunk) return [];
    if (chunk.length <= max) return [{ content: chunk, path }];

    const [head, ...rest] = group;
    const body = rest.join('\n').trim();
    if (!body) return [{ content: chunk, path }];

    const label = labelOf(head);
    const inner = splitOutline(body, path ? `${path} > ${label}` : label, max);
    // The item's own line rides with its first child, so no text is dropped on the way down.
    if (inner.length) inner[0] = { ...inner[0], content: `${head.trim()}\n${inner[0].content}` };
    return inner;
  });
}

function splitOversized(blocks: Block[]): Block[] {
  return blocks.flatMap((block) => {
    if (block.kind !== 'list' || block.content.length <= MAX_LIST_BLOCK) return [block];
    return splitOutline(block.content, block.headingPath, MAX_LIST_BLOCK).map((piece) => ({
      ...block,
      content: piece.content,
      contentHash: sha256(piece.content),
      headingPath: piece.path,
    }));
  });
}

function reindex(blocks: Block[]): Block[] {
  return blocks.map((b, idx) => ({ ...b, idx }));
}

/**
 * Rejoin list runs that a blank line split apart.
 *
 * Joseph writes numbered mechanisms with a blank line between steps, so the naive splitter turns
 * the four steps of `Linear Probing` into four blocks. That is wrong twice over: the steps of one
 * mechanism are a single unit of meaning, and treating them separately means reordering them
 * reads as four edits instead of zero.
 */
function mergeAdjacentLists(blocks: Block[]): Block[] {
  const merged: Block[] = [];

  for (const block of blocks) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.kind === 'list' &&
      block.kind === 'list' &&
      prev.headingPath === block.headingPath
    ) {
      prev.content = `${prev.content}\n\n${block.content}`;
      prev.contentHash = sha256(prev.content);
      continue;
    }
    merged.push({ ...block, idx: merged.length });
  }

  return merged;
}

export interface BlockDiff {
  added: Block[];
  changed: Block[];
  removedHashes: string[];
}

/**
 * Compare a note's current blocks against the snapshot stored on the last scan.
 *
 * Hash-set comparison rather than a positional diff: moving a paragraph without editing it is
 * not a change worth re-extracting, and this treats it correctly for free. `changed` is the
 * subset of new blocks that share a heading path with a block that disappeared — a decent proxy
 * for "this section was edited" rather than "this section is new".
 */
export function diffBlocks(previous: Block[], current: Block[]): BlockDiff {
  const prevHashes = new Set(previous.map((b) => b.contentHash));
  const currHashes = new Set(current.map((b) => b.contentHash));

  const fresh = current.filter((b) => !prevHashes.has(b.contentHash));

  // A block whose hash is gone has not necessarily lost its text: changing where the splitter
  // draws its boundaries rehashes everything while the prose sits exactly where it was. Cards
  // carry the hash of the block they came from, so taking the hash at face value would retire
  // most of the deck the first time the splitter changes. Only text that is genuinely absent from
  // the note counts as removed.
  const bare = (s: string) => s.replace(/\s+/g, ' ').trim();
  const haystack = bare(current.map((b) => b.content).join(' '));
  const removed = previous.filter(
    (b) => !currHashes.has(b.contentHash) && !haystack.includes(bare(b.content)),
  );
  const removedSections = new Set(removed.map((b) => b.headingPath ?? ''));

  return {
    added: fresh.filter((b) => !removedSections.has(b.headingPath ?? '')),
    changed: fresh.filter((b) => removedSections.has(b.headingPath ?? '')),
    removedHashes: removed.map((b) => b.contentHash),
  };
}

/** A readable diff for the approval queue: what changed that produced this target. */
export function renderDiff(diff: BlockDiff): string {
  const lines: string[] = [];
  for (const b of diff.changed) lines.push(`~ ${b.content}`);
  for (const b of diff.added) lines.push(`+ ${b.content}`);
  return lines.join('\n\n');
}
