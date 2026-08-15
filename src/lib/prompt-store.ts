import { constants as fsConstants } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The prompts and knobs, on disk and editable.
 *
 * They live as files under `prompts/` rather than as string literals in TypeScript for two
 * reasons. The scanner is a separate process from the web app, so a file is the only thing both
 * can read without a restart or a shared cache — edit a prompt in the browser and the next scan
 * picks it up. And they stay in git, so a change in extraction quality can be traced to the
 * change in wording that caused it.
 *
 * Nothing is validated beyond shape. A prompt is prose; the only way to know an edit was an
 * improvement is to run it and read the output.
 */

export const PROMPT_FILES = {
  'stage1-sweep': {
    title: 'Stage 1 — sweep',
    file: 'stage1-sweep.md',
    role: 'Reads a changed note and proposes reinforcement targets, proportional to substance.',
  },
  'stage1-targeted': {
    title: 'Stage 1 — targeted',
    file: 'stage1-targeted.md',
    role: 'Reads a note you picked and finds only what you asked for.',
  },
  'stage2-write': {
    title: 'Stage 2 — write',
    file: 'stage2-write.md',
    role: 'Turns each approved target into candidate cards.',
  },
  'stage3-judge': {
    title: 'Stage 3 — judge',
    file: 'stage3-judge.md',
    role: 'Scores every candidate and keeps the best. This is the filter.',
  },
  'quick-add': {
    title: 'Quick add',
    file: 'quick-add.md',
    role:
      'One pass, no pipeline, and deliberately none of the shared principles — Add cards follows ' +
      'your request rather than the methodology, and you verify the result before it is saved.',
  },
  dedup: {
    title: 'Dedup',
    file: 'dedup.md',
    role: 'Decides whether a candidate duplicates a card already in the deck.',
  },
  principles: {
    title: 'Principles',
    root: 'docs',
    file: 'prompt-principles.md',
    role: 'Injected verbatim into every stage above, wherever {{PRINCIPLES}} appears.',
  },
} as const;

export type PromptKey = keyof typeof PROMPT_FILES;

/** The SDK's effort levels. Kept narrow so a typo in the config file can't reach the API. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface Config {
  wordsPerTarget: number;
  targetsPerNoteMax: number;
  candidatesPerTarget: number;
  cardsPerTarget: number;
  keepScoreThreshold: number;
  batchSize: number;
  duplicateCertain: number;
  duplicateGrey: number;
  coverageContext: number;
  model: string;
  modelDedup: string;
  effortStage1: Effort;
  effortStage2: Effort;
  effortStage3: Effort;
  effortQuickAdd: Effort;
}

export const CONFIG_LABELS: Record<keyof Config, string> = {
  wordsPerTarget: 'Words of substance per target proposed. Lower = denser coverage.',
  targetsPerNoteMax: 'Hard ceiling on targets from one note.',
  candidatesPerTarget: 'Draft cards written per target, before filtering.',
  cardsPerTarget: 'How many survive into the deck. 1 avoids near-siblings in a session.',
  keepScoreThreshold: "Judge score (0-10) a card must clear. Raise to be pickier.",
  batchSize: 'Targets per stage 2/3 call. Higher is cheaper, lower gets more attention each.',
  duplicateCertain: 'Similarity above which a card is dropped as a duplicate without asking.',
  duplicateGrey: 'Similarity above which the model is asked whether it is a duplicate.',
  coverageContext: 'Existing cards shown to stage 1 so it knows what ground is taken.',
  model: 'Model for stages 1-3.',
  modelDedup: 'Model for the duplicate check. A cheap one is fine.',
  effortStage1: 'Reasoning effort when choosing targets.',
  effortStage2: 'Reasoning effort when writing cards.',
  effortStage3: 'Reasoning effort when judging.',
  effortQuickAdd: 'Reasoning effort for the one-pass Add cards flow. Lower is faster.',
};

const CONFIG_FILE = 'config.json';

export const DEFAULT_CONFIG: Config = {
  wordsPerTarget: 110,
  targetsPerNoteMax: 40,
  candidatesPerTarget: 3,
  cardsPerTarget: 1,
  keepScoreThreshold: 6,
  batchSize: 5,
  duplicateCertain: 0.72,
  duplicateGrey: 0.3,
  coverageContext: 14,
  model: 'claude-sonnet-5',
  modelDedup: 'claude-haiku-4-5',
  effortStage1: 'high',
  effortStage2: 'high',
  effortStage3: 'high',
  effortQuickAdd: 'medium',
};

/** Where the editable prompts live, relative to the app root. */
const PROMPTS_DIR = 'prompts';

/**
 * Resolve a prompt file by name.
 *
 * The directory is a literal here rather than part of the caller's string on purpose: a bundler
 * can see `join(cwd(), 'prompts', name)` is confined to one folder and trace just that folder,
 * where `join(cwd(), someVariable)` forces it to ship the entire project — every source file and
 * everything in `public/` — into the serverless bundle.
 */
function resolve(file: string, root?: string): string {
  // Both branches join a *literal* directory. A bundler can see each is confined to one folder
  // and trace just that folder; `join(cwd(), someVariable)` makes it ship the entire project.
  return root === 'docs'
    ? path.join(process.cwd(), 'docs', file)
    : path.join(process.cwd(), PROMPTS_DIR, file);
}

/** The registry entries carry an optional root, so read and write agree on where a file lives. */
function locate(key: PromptKey): string {
  const entry = PROMPT_FILES[key] as { file: string; root?: string };
  return resolve(entry.file, entry.root);
}

/**
 * Can the prompts be edited here?
 *
 * A hosted deployment has a read-only filesystem, so prompts are readable but frozen at whatever
 * was committed. Worth saying up front rather than after someone has retyped a prompt and hit
 * save.
 */
export async function promptsWritable(): Promise<boolean> {
  try {
    await access(path.join(process.cwd(), PROMPTS_DIR), fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const READ_ONLY =
  'This deployment has a read-only filesystem, so prompts can be read but not edited here. ' +
  'Edit them in the repo, or run the app locally.';

export async function readPrompt(key: PromptKey): Promise<string> {
  return readFile(locate(key), 'utf8');
}

export async function writePrompt(key: PromptKey, body: string): Promise<void> {
  if (!body.trim()) throw new Error('A prompt cannot be empty.');
  if (!(await promptsWritable())) throw new Error(READ_ONLY);
  await writeFile(locate(key), body, 'utf8');
}

export async function readConfig(): Promise<Config> {
  try {
    const raw = await readFile(resolve(CONFIG_FILE), 'utf8');
    // Merge over defaults so a config written before a knob existed still loads.
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<Config>) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function writeConfig(next: Partial<Config>): Promise<Config> {
  const merged = { ...(await readConfig()), ...next };

  for (const k of ['effortStage1', 'effortStage2', 'effortStage3', 'effortQuickAdd'] as const) {
    if (!EFFORTS.includes(merged[k])) throw new Error(`${k} must be one of: ${EFFORTS.join(', ')}`);
  }

  // Guard the two that can quietly break a run rather than just make it worse.
  if (merged.duplicateGrey >= merged.duplicateCertain) {
    throw new Error('duplicateGrey must be below duplicateCertain — otherwise the band is empty.');
  }
  if (merged.cardsPerTarget > merged.candidatesPerTarget) {
    throw new Error('cardsPerTarget cannot exceed candidatesPerTarget — there would be nothing to pick from.');
  }

  if (!(await promptsWritable())) throw new Error(READ_ONLY);
  await writeFile(resolve(CONFIG_FILE), JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}
