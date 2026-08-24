import { NextResponse } from 'next/server';
import { vaultStatus } from '@/lib/environment';
import { readConfig } from '@/lib/prompt-store';
import * as z from 'zod';
import { zQuickBatch, type QuickCard } from '@/lib/types';
import { complete } from '@/scanner/llm';
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
  const vault = await vaultStatus();
  if (!vault.available) {
    return NextResponse.json({ error: vault.reason }, { status: 503 });
  }

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

  // Follows the same `provider` switch as the nightly pipeline. A flag that moved stages 1-4 to
  // Ollama but quietly left this one on Anthropic would be the worst of both — you would think
  // the deck was being written locally while half of it still wasn't.
  const model = cfg.provider === 'ollama' ? cfg.ollamaModel : cfg.model;

  try {
    const { parsed, usage } = await complete<z.infer<typeof zQuickBatch>>({
      stage: 'quick add',
      model,
      schema: zQuickBatch,
      maxTokens: 32000,
      effort: cfg.effortQuickAdd,
      contextLimit: cfg.ollamaContext,
      system: await QUICK_ADD_SYSTEM(),
      user,
    });

    return NextResponse.json({
      cards: (parsed?.cards ?? []) as QuickCard[],
      skipped_reason: parsed?.skipped_reason ?? null,
      notes: notes.map((n) => ({ path: n.path, title: n.title })),
      model,
      usage: {
        input:
          usage.input_tokens +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0),
        output: usage.output_tokens,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
