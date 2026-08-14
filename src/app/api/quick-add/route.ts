import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { NextResponse } from 'next/server';
import { readConfig } from '@/lib/prompt-store';
import { zQuickBatch, type QuickCard } from '@/lib/types';
import { QUICK_ADD_SYSTEM } from '@/scanner/prompts';
import { parseNote, vaultRoot } from '@/scanner/vault';
import path from 'node:path';

export const maxDuration = 300;

/**
 * One pass, nothing saved.
 *
 * The nightly pipeline is three model calls per batch plus a dedup check, which is right when
 * nobody is waiting. Here somebody is: you have picked notes, named what you want, and are
 * watching a spinner. So this is a single call that returns finished cards, and they are handed
 * straight back rather than written to the database — you approve them first. That review is the
 * whole reason this path can skip the judge.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as { paths?: string[]; request?: string; count?: number };

  if (!body.paths?.length) {
    return NextResponse.json({ error: 'Pick at least one note.' }, { status: 400 });
  }
  if (!body.request?.trim()) {
    return NextResponse.json({ error: 'Describe what to extract.' }, { status: 400 });
  }

  const root = vaultRoot();
  const notes = [];
  for (const rel of body.paths.slice(0, 8)) {
    try {
      notes.push(await parseNote(path.join(root, rel), root));
    } catch {
      // A note that can't be read (iCloud eviction) shouldn't sink the whole request.
    }
  }
  if (!notes.length) {
    return NextResponse.json({ error: 'None of those notes could be read.' }, { status: 400 });
  }

  const cfg = await readConfig();

  // A requested count is a target, not a quota — padding to hit a number is worse than coming
  // back short, and he can always ask again.
  const count = Number.isFinite(body.count) && (body.count as number) > 0 ? Math.round(body.count as number) : null;

  const user = [
    '# The request',
    '',
    '> ' + body.request.trim().split('\n').join('\n> '),
    '',
    'Write cards for exactly this, from the notes below. Nothing else.',
    '',
    ...(count
      ? [
          `He has asked for **around ${count} card${count === 1 ? '' : 's'}**. Aim for that. If the`,
          'material honestly holds fewer, write fewer and say so — do not pad to reach the number.',
          'If it holds more and they are all genuinely what he asked for, going a little over is fine.',
          '',
        ]
      : [
          'He has not set a number — write as many as the material holds for this request, and no more.',
          '',
        ]),
    '---',
    '',
    ...notes.flatMap((n) => [
      `# ${n.title}`,
      '',
      '```markdown',
      n.content,
      '```',
      '',
    ]),
  ].join('\n');

  try {
    const stream = new Anthropic().messages.stream({
      model: cfg.model,
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      output_config: { effort: cfg.effortQuickAdd, format: zodOutputFormat(zQuickBatch) },
      system: [
        { type: 'text', text: await QUICK_ADD_SYSTEM(), cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: user }],
    });

    const message = await stream.finalMessage();

    if (message.stop_reason === 'max_tokens') {
      return NextResponse.json(
        { error: 'Ran out of room before finishing — try fewer notes or a narrower request.' },
        { status: 500 },
      );
    }

    const parsed = message.parsed_output;
    return NextResponse.json({
      cards: (parsed?.cards ?? []) as QuickCard[],
      skipped_reason: parsed?.skipped_reason ?? null,
      notes: notes.map((n) => ({ path: n.path, title: n.title })),
      usage: {
        input:
          message.usage.input_tokens +
          (message.usage.cache_creation_input_tokens ?? 0) +
          (message.usage.cache_read_input_tokens ?? 0),
        output: message.usage.output_tokens,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
