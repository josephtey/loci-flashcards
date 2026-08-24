import { readFile } from 'node:fs/promises';
import { config as dotenv } from 'dotenv';
dotenv({ path: '.env.local' });

/**
 * What would each provider actually pull out of a note?
 *
 * `NOTE=<path> npm run bench:extract [model...]` — runs stage 1, the hardest and most consequential
 * call in the pipeline, against one real note on each model named, and prints the targets side by
 * side. Nothing is written: this reads the vault and the model, and touches neither the database
 * nor the deck.
 *
 * It exists because `provider` is a one-word switch with a large blast radius. Flipping it moves
 * every card the nightly scan writes onto a different model, and the only honest way to decide
 * whether that is acceptable is to look at what the two produce from the same note.
 */
import * as z from 'zod';
import { zTargetBatch } from '../lib/types';
import { readConfig } from '../lib/prompt-store';
import { complete } from './llm';
import { STAGE1_SYSTEM, stage1User } from './prompts';

const NOTE = process.env.NOTE;
if (!NOTE) {
  console.error('Set NOTE to the absolute path of a note. e.g.\n  NOTE="$VAULT_PATH/Ever Green Learnings/…​.md" npm run bench:extract');
  process.exit(1);
}

const cfg = await readConfig();
// Default to the pair the config would actually use, so the no-argument form answers the
// question you have: "what would flipping the switch do to my deck?"
const MODELS = process.argv.slice(2);
if (!MODELS.length) MODELS.push(cfg.ollamaModel, cfg.model);

const content = await readFile(NOTE, 'utf8');
const title = NOTE.split('/').pop()!.replace(/\.md$/, '');

const system = await STAGE1_SYSTEM();
const user = stage1User({
  title,
  folder: 'Ever Green Learnings',
  subfolder: null,
  content,
  changedText: content,
  isNew: true,
  linked: [],
  existingFronts: [],
  rejections: [],
  emphasis: [],
  budget: 6,
});

console.log(`note: ${title}  (${content.length} chars)`);
console.log(`prompt: system ${system.length} chars + user ${user.length} chars ≈ ${Math.ceil((system.length + user.length) / 3)} tokens\n`);

for (const model of MODELS) {
  const t = Date.now();
  try {
    const { parsed, usage } = await complete<z.infer<typeof zTargetBatch>>({
      stage: 'stage 1 (targets)',
      model,
      schema: zTargetBatch,
      maxTokens: 32000,
      effort: 'high',
      contextLimit: 32768,
      system,
      user,
    });
    const secs = ((Date.now() - t) / 1000).toFixed(1);
    const targets = parsed?.targets ?? [];
    console.log(`${'='.repeat(76)}\n${model} — ${targets.length} targets, ${secs}s, ${usage.input_tokens} in / ${usage.output_tokens} out\n${'='.repeat(76)}`);
    for (const t2 of targets.slice(0, 6)) {
      console.log(`\n  [${t2.angle}] ${t2.excerpt.slice(0, 150).replace(/\n/g, ' ')}`);
      console.log(`     why: ${t2.rationale.slice(0, 150)}`);
    }
    if (parsed?.skipped_reason) console.log(`\n  skipped: ${parsed.skipped_reason}`);
  } catch (e) {
    console.log(`${'='.repeat(76)}\n${model} — FAILED after ${((Date.now() - t) / 1000).toFixed(1)}s\n  ${(e as Error).message}`);
  }
  console.log();
}
