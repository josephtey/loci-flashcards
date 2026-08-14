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
  return mergeAdjacentLists(blocks);
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
  const removed = previous.filter((b) => !currHashes.has(b.contentHash));
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
