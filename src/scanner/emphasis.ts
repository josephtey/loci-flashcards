/**
 * Material Joseph has flagged as worth remembering.
 *
 * The extractor decides what deserves a prompt by reading the note, which is the hardest
 * judgement in the pipeline and the one it is worst at — it cannot see what he already knows or
 * what he was excited about while writing. A marker in the note itself is the cheapest possible
 * channel for that intent: write `***` beside a passage and the sweep treats it as load-bearing
 * rather than guessing.
 *
 * The marker is configurable because it has to be something that never occurs by accident in his
 * own writing, and only he knows what that is.
 */

/** A flagged passage, with the marker removed — the model should never see the notation itself. */
export interface Emphasis {
  /** The flagged text, marker stripped. */
  text: string;
  /** Words in it, for weighting the target budget. */
  words: number;
}

const MAX_SPAN_LINES = 12;

function indentOf(line: string): number {
  const ws = /^[ \t]*/.exec(line)![0];
  return [...ws].reduce((n, c) => n + (c === '\t' ? 4 : 1), 0);
}

function stripMarker(line: string, marker: string): string {
  return line.split(marker).join('').replace(/\s+$/, '');
}

function countWords(s: string): number {
  return s.split(/\s+/).filter((w) => /[a-z]/i.test(w)).length;
}

/**
 * Find every passage the marker points at.
 *
 * Two ways of writing it, because both are natural and it would be irritating to have to
 * remember which one counts:
 *
 *   - inline — `***the thing that matters***`, or a bullet ending in `***`. The line itself is
 *     the flagged passage.
 *   - on its own line — the marker sits above or below a passage. What it points at is the
 *     following lines, down to the next line at the same indentation or shallower, so flagging a
 *     parent bullet takes its children with it.
 */
export function findEmphasis(text: string, marker: string): Emphasis[] {
  const mark = marker.trim();
  if (!mark || !text.includes(mark)) return [];

  const lines = text.split('\n');
  const out: Emphasis[] = [];
  const claimed = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(mark) || claimed.has(i)) continue;

    const bare = stripMarker(lines[i], mark).trim();
    // A line with content of its own is the flagged passage.
    if (bare && !/^[-*+]$|^\d+[.)]$/.test(bare)) {
      claimed.add(i);
      out.push({ text: bare, words: countWords(bare) });
      continue;
    }

    // A marker alone points at the passage beside it: the lines that follow, or — if it is the
    // last thing in the block — the line above.
    const span: string[] = [];
    const base = indentOf(lines[i]);
    for (let j = i + 1; j < lines.length && span.length < MAX_SPAN_LINES; j++) {
      if (!lines[j].trim()) {
        if (span.length) break;
        continue;
      }
      if (span.length && indentOf(lines[j]) <= base) break;
      claimed.add(j);
      span.push(stripMarker(lines[j], mark));
    }
    if (!span.length && i > 0) {
      claimed.add(i - 1);
      span.push(stripMarker(lines[i - 1], mark));
    }
    claimed.add(i);

    const body = span.join('\n').trim();
    if (body) out.push({ text: body, words: countWords(body) });
  }

  return out;
}

/** Total words under emphasis, for scaling how much coverage the note earns. */
export function emphasisWords(spans: Emphasis[]): number {
  return spans.reduce((n, s) => n + s.words, 0);
}
