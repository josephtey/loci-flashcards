import { NextResponse } from 'next/server';
import {
  CONFIG_LABELS,
  PROMPT_FILES,
  readConfig,
  readPrompt,
  writeConfig,
  writePrompt,
  type Config,
  type PromptKey,
} from '@/lib/prompt-store';

/**
 * Read and write the extraction prompts and their tuning.
 *
 * Writes go to files on disk, which is what makes them take effect: the scanner is a separate
 * process and reads them at call time, so there is nothing to restart or invalidate.
 */
export async function GET() {
  const keys = Object.keys(PROMPT_FILES) as PromptKey[];
  const prompts = await Promise.all(
    keys.map(async (key) => ({
      key,
      ...PROMPT_FILES[key],
      // Swallowing the error rendered a missing file as an empty editor — and saving from there
      // would have written that emptiness back over the real one.
      body: await readPrompt(key).catch((e: unknown) => {
        console.error(`prompt "${key}" could not be read:`, e);
        return null;
      }),
    })),
  );
  return NextResponse.json({ prompts, config: await readConfig(), labels: CONFIG_LABELS });
}

export async function PUT(req: Request) {
  const body = (await req.json()) as {
    key?: PromptKey;
    body?: string;
    config?: Partial<Config>;
  };

  try {
    if (body.config) {
      return NextResponse.json({ ok: true, config: await writeConfig(body.config) });
    }
    if (body.key && typeof body.body === 'string') {
      if (!(body.key in PROMPT_FILES)) {
        return NextResponse.json({ error: 'Unknown prompt' }, { status: 400 });
      }
      await writePrompt(body.key, body.body);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: 'Nothing to write' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
