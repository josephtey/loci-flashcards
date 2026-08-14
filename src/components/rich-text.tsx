import { Fragment, type ReactNode } from 'react';

/**
 * The smallest markdown renderer that covers the vault's idiom: **bold**, *italic*, `code`,
 * $LaTeX$ left as literal text, and numbered/bulleted lists. Deliberately not a full parser —
 * a card that needs more formatting than this is a card that is doing too much.
 */

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|==[^=]+==)/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).map((chunk, i) => {
    const key = `${keyPrefix}-${i}`;
    if (chunk.startsWith('**') && chunk.endsWith('**')) {
      return <strong key={key}>{chunk.slice(2, -2)}</strong>;
    }
    if (chunk.startsWith('`') && chunk.endsWith('`') && chunk.length > 1) {
      return <code key={key}>{chunk.slice(1, -1)}</code>;
    }
    if (chunk.startsWith('==') && chunk.endsWith('==') && chunk.length > 3) {
      return (
        <mark key={key} className="bg-transparent text-ink underline decoration-ink-3 underline-offset-4">
          {chunk.slice(2, -2)}
        </mark>
      );
    }
    if (chunk.startsWith('*') && chunk.endsWith('*') && chunk.length > 1) {
      return <em key={key}>{chunk.slice(1, -1)}</em>;
    }
    return <Fragment key={key}>{chunk}</Fragment>;
  });
}

export function RichText({ text, className = '' }: { text: string; className?: string }) {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    out.push(
      <Tag
        key={`list-${out.length}`}
        className={list.ordered ? 'list-decimal pl-5' : 'list-disc pl-5'}
      >
        {list.items.map((item, i) => (
          <li key={i}>{inline(item, `li-${out.length}-${i}`)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };

  const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
  const BULLETED = /^\s*[-*+]\s+(.*)$/;

  lines.forEach((line, i) => {
    const ordered = line.match(ORDERED);
    const bulleted = line.match(BULLETED);

    if (ordered || bulleted) {
      const isOrdered = Boolean(ordered);
      const item = (ordered ?? bulleted)![1];
      if (!list || list.ordered !== isOrdered) {
        flush();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push(item);
      return;
    }

    if (!line.trim()) {
      // A blank line inside a list run is spacing, not a terminator. Joseph writes numbered
      // steps with blank lines between them, so flushing here restarts the numbering at 1 for
      // every item. Only end the list if what follows isn't another item of the same kind.
      if (list) {
        const next = lines.slice(i + 1).find((l) => l.trim());
        const continues = next
          ? Boolean(list.ordered ? next.match(ORDERED) : next.match(BULLETED))
          : false;
        if (continues) return;
      }
      flush();
      return;
    }

    flush();
    out.push(<p key={`p-${i}`}>{inline(line, `p-${i}`)}</p>);
  });

  flush();

  return <div className={`prose-card space-y-3 ${className}`}>{out}</div>;
}
