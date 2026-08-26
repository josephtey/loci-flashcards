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
  'grade-answer': {
    title: 'Grade a typed answer',
    file: 'grade-answer.md',
    role:
      'Turns a typed recall attempt into one of the four grades. Runs on a small local model ' +
      'rather than Claude, and none of the shared principles apply — this one is about ' +
      'measuring retrieval, not writing prompts.',
  },
  explain: {
    title: 'Explain a card',
    file: 'explain.md',
    role:
      'A short, ungraded aside for a card you got stuck on. Follows the same provider switch ' +
      'as grading — none of the shared principles apply here either.',
  },
  principles: {
    title: 'Principles',
    root: 'docs',
    file: 'prompt-principles.md',
    role: 'Injected verbatim into every stage above, wherever {{PRINCIPLES}} appears.',
  },
} as const;

export type PromptKey = keyof typeof PROMPT_FILES;

/**
 * Who runs every model call in the project.
 *
 * One switch, no exceptions: grading typed answers, all four extraction stages, and the Add cards
 * flow all follow it. `claude` is Anthropic's API; `ollama` is Ollama's hosted service, which
 * means `gpt-oss:120b` and nothing else.
 *
 * `ollama` is the default: it is free, and on grading it matches a human (18/18 on the
 * benchmark). Extraction is the weaker half — measured against Sonnet on the same note it found
 * 6 targets to 14, and some excerpts came back paraphrased rather than quoted. Switch to
 * `claude` for a scan you care about, and read what a scan produces either way.
 */
export const PROVIDERS = ['claude', 'ollama'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

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
  emphasisMarker: string;
  emphasisWeight: number;
  model: string;
  modelDedup: string;
  effortStage1: Effort;
  effortStage2: Effort;
  effortStage3: Effort;
  effortQuickAdd: Effort;
  graderAutoAccept: boolean;
  provider: ProviderName;
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
  emphasisMarker:
    'Write this beside a passage in a note to flag it as worth remembering. Pick something that never occurs by accident in your own writing.',
  emphasisWeight:
    'How much more coverage flagged material earns. 3 means it counts triple towards the target budget.',
  model: 'Anthropic model for stages 1-3 and Add cards. Ignored when provider is ollama.',
  modelDedup:
    'Anthropic model for the two cheap calls — the duplicate check and grading a typed answer. ' +
    'Ignored when provider is ollama.',
  effortStage1: 'Reasoning effort when choosing targets.',
  effortStage2: 'Reasoning effort when writing cards.',
  effortStage3: 'Reasoning effort when judging.',
  effortQuickAdd: 'Reasoning effort for the one-pass Add cards flow. Lower is faster.',
  graderAutoAccept:
    'Commit the grade the moment the model returns it, instead of waiting for you to accept. ' +
    'Leave this off until the verdicts have earned it.',
  provider:
    'Who runs every model call — grading, all four extraction stages, and Add cards. ' +
    'ollama means gpt-oss:120b on Ollama\u2019s hosted service and needs OLLAMA_API_KEY.',
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
  emphasisMarker: '***',
  emphasisWeight: 3,
  model: 'claude-sonnet-5',
  modelDedup: 'claude-haiku-4-5',
  effortStage1: 'high',
  effortStage2: 'high',
  effortStage3: 'high',
  effortQuickAdd: 'medium',
  graderAutoAccept: false,
  provider: 'ollama',
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
    const merged = { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<Config>) };
    // The provider was briefly called `anthropic`. Read the old name rather than reject a file
    // written last week.
    if ((merged.provider as string) === 'anthropic') merged.provider = 'claude';
    return merged;
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
  // An empty or one-character marker would match half the note and silently flag everything.
  if (merged.emphasisMarker.trim().length < 2) {
    throw new Error('emphasisMarker needs at least two characters, or it will match by accident.');
  }
  if (!(merged.emphasisWeight >= 1)) {
    throw new Error('emphasisWeight must be at least 1 — below that, flagging would demote.');
  }
  if (!PROVIDERS.includes(merged.provider)) {
    throw new Error(`provider must be one of: ${PROVIDERS.join(', ')}`);
  }
  if (merged.cardsPerTarget > merged.candidatesPerTarget) {
    throw new Error('cardsPerTarget cannot exceed candidatesPerTarget — there would be nothing to pick from.');
  }

  if (!(await promptsWritable())) throw new Error(READ_ONLY);
  await writeFile(resolve(CONFIG_FILE), JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}
