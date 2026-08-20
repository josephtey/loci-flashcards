import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readPrompt, type PromptKey } from '../lib/prompt-store';
import {
  ANGLE_DESCRIPTIONS,
  CONCEPTUAL_ANGLES,
  FOUNDATIONAL_ANGLES,
  PROCEDURAL_ANGLES,
  SALIENCE_ANGLES,
  type Angle,
} from '../lib/types';

/**
 * The extractor's prompts.
 *
 * `docs/prompt-principles.md` §2–§4 are injected verbatim rather than paraphrased. Matuschak's
 * own finding is that LLMs write materially better prompts when handed the prompt-writing
 * principles explicitly, and better still when asked to justify each prompt against them — which
 * is why every candidate carries a `justification` field it has to fill in.
 */

let cachedPrinciples: string | null = null;

export async function principles(): Promise<string> {
  if (cachedPrinciples) return cachedPrinciples;
  const file = path.join(process.cwd(), 'docs', 'prompt-principles.md');
  const raw = await readFile(file, 'utf8');

  // §2 Principles through the end of §4 (the catechism section). §0–1 are architecture and
  // §5 onward is review mechanics — neither is the model's business.
  const start = raw.indexOf('## 2. Principles');
  const end = raw.indexOf('## 5. Review mechanics');
  cachedPrinciples = start === -1 ? raw : raw.slice(start, end === -1 ? undefined : end).trim();
  return cachedPrinciples;
}

function angleMenu(angles: readonly Angle[]): string {
  return angles.map((a) => `  - ${a}: ${ANGLE_DESCRIPTIONS[a]}`).join('\n');
}

/** Folder policy. The two Evergreen folders hold genuinely different kinds of writing. */
export function folderGuidance(folder: string): string {
  if (folder === 'Ever Green Notes') {
    return [
      'This note is from `Ever Green Notes`: Joseph\'s own claim-titled essays, Andy Matuschak style.',
      'The title IS the claim; the body is his argument for it.',
      '',
      'These are a catechism, not a quiz. Prefer the `claim`, `application`, and `salience` angles.',
      'The point is to keep him in live contact with his own thinking so it stays available and gets',
      'revised — not to test recall of what he wrote.',
      '',
      'The expert-response heuristic does NOT apply here. These positions are his, and their value is',
      'precisely that they are parochial. A prompt that could be answered by any expert in the field',
      'has missed the note.',
    ].join('\n');
  }
  return [
    'This note is from `Ever Green Learnings`: technical explainers, usually written as numbered',
    'mechanistic steps, with LaTeX and bolded key terms.',
    '',
    'The expert-response heuristic applies: someone who already knows this topic should be able to',
    'answer the prompt without having read this specific note. A prompt that depends on Joseph\'s',
    'particular phrasing encodes a parochial understanding.',
  ].join('\n');
}

/**
 * System prompts are read from `prompts/*.md` at call time, so an edit in the methodology page
 * takes effect on the next run without a restart. `{{PLACEHOLDERS}}` are filled here: the angle
 * menus come from the type definitions so they can never drift from what the schema accepts,
 * and `{{PRINCIPLES}}` splices in the shared document.
 */
async function render(key: PromptKey): Promise<string> {
  const raw = await readPrompt(key);
  return raw
    .replaceAll('{{ANGLES_FOUNDATIONAL}}', angleMenu(FOUNDATIONAL_ANGLES))
    .replaceAll('{{ANGLES_CONCEPTUAL}}', angleMenu(CONCEPTUAL_ANGLES))
    .replaceAll('{{ANGLES_PROCEDURAL}}', angleMenu(PROCEDURAL_ANGLES))
    .replaceAll('{{ANGLES_SALIENCE}}', angleMenu(SALIENCE_ANGLES))
    .replaceAll('{{PRINCIPLES}}', await principles());
}

export const STAGE1_SYSTEM = () => render('stage1-sweep');
export const STAGE1_TARGETED_SYSTEM = () => render('stage1-targeted');
export const STAGE2_SYSTEM = () => render('stage2-write');
export const JUDGE_SYSTEM = () => render('stage3-judge');
export const DEDUP_SYSTEM = () => render('dedup');
export const QUICK_ADD_SYSTEM = () => render('quick-add');

export interface LinkedNote {
  title: string;
  excerpt: string;
}

export function stage1User(opts: {
  title: string;
  folder: string;
  subfolder: string | null;
  content: string;
  changedText: string;
  isNew: boolean;
  linked: LinkedNote[];
  existingFronts: string[];
  rejections: { original: string; reason: string }[];
  emphasis: string[];
  budget: number;
}): string {
  const parts: string[] = [];

  parts.push(`# Note: ${opts.title}`);
  parts.push(`Folder: ${opts.folder}${opts.subfolder ? ` / ${opts.subfolder}` : ''}`);
  parts.push('');
  parts.push(folderGuidance(opts.folder));
  parts.push('');
  parts.push('## Full note');
  parts.push('');
  parts.push('```markdown');
  parts.push(opts.content);
  parts.push('```');

  parts.push('');
  if (opts.isNew) {
    parts.push('## What changed');
    parts.push('');
    parts.push('This note is new since the last scan. All of it is fair game.');
  } else {
    parts.push('## What changed');
    parts.push('');
    parts.push(
      'Only the following was added or edited since the last scan. **Propose targets only from this',
    );
    parts.push(
      'changed material** — the rest of the note is context for understanding it, not a source of',
    );
    parts.push('targets. Anything unchanged has already been through this process.');
    parts.push('');
    parts.push('```diff');
    parts.push(opts.changedText);
    parts.push('```');
  }

  if (opts.linked.length) {
    parts.push('');
    parts.push('## Linked notes (context — do not propose targets from these)');
    parts.push('');
    for (const l of opts.linked) {
      parts.push(`### ${l.title}`);
      parts.push(l.excerpt);
      parts.push('');
    }
  }

  if (opts.existingFronts.length) {
    parts.push('');
    parts.push('## Cards that already exist from this note');
    parts.push('');
    parts.push('Do not propose a target that would duplicate one of these:');
    parts.push('');
    for (const f of opts.existingFronts) parts.push(`- ${f}`);
  }

  if (opts.rejections.length) {
    parts.push('');
    parts.push('## Targets Joseph recently rejected');
    parts.push('');
    parts.push('His taste, in his own words. Calibrate to it:');
    parts.push('');
    for (const r of opts.rejections) {
      parts.push(`- "${r.original.slice(0, 180)}"`);
      parts.push(`  → rejected: ${r.reason || '(no reason given)'}`);
    }
  }

  // Joseph's own signal about what matters, and the only one the model can't infer from the text.
  if (opts.emphasis.length) {
    parts.push('');
    parts.push('## Flagged by Joseph as worth remembering');
    parts.push('');
    parts.push(
      'He marked these passages in the note itself. This is his judgement about what is ' +
        'load-bearing, and it outranks yours: cover every one of them, and cover them more ' +
        'thoroughly than the surrounding material — several angles on one flagged passage is ' +
        'right where one would do elsewhere. Only skip a flagged passage if it fails the ' +
        'cover-the-answer test outright.',
    );
    parts.push('');
    parts.push(
      'The marker notation is an instruction to you, not part of the material. Never quote it in ' +
        'an excerpt or a card.',
    );
    parts.push('');
    for (const e of opts.emphasis) {
      parts.push('> ' + e.split('\n').join('\n> '));
      parts.push('');
    }
  }

  parts.push('');
  parts.push(
    `Sweep this material and propose around **${opts.budget} targets** — that figure is scaled to how ` +
      'much substance is here, so treat it as the expected yield rather than a ceiling to fill or a ' +
      'quota to hit. Go over if the note genuinely carries more; stop well short if it does not. ' +
      'Work in the order the material appears so the coverage is even.',
  );

  return parts.join('\n');
}

export function stage2BatchUser(opts: {
  title: string;
  folder: string;
  content: string;
  targets: { excerpt: string; angle: Angle; rationale: string }[];
  count: number;
  /** The request these targets came from, when this was a targeted extraction. */
  request?: string;
}): string {
  const parts = [
    `# Note: ${opts.title}`,
    '',
  ];

  if (opts.request?.trim()) {
    parts.push(
      '## What was asked for',
      '',
      '> ' + opts.request.trim().split('\n').join('\n> '),
      '',
      'These targets were selected to answer that request. If it names a card form — cloze,',
      'definitions, "just the numbers" — write to that form rather than defaulting to Q&A. If it',
      'names no form, use your usual judgement.',
      '',
    );
  }

  parts.push(
    '',
    folderGuidance(opts.folder),
    '',
    '## The full note, for context',
    '',
    '```markdown',
    opts.content,
    '```',
    '',
    '## Targets',
    '',
  );

  opts.targets.forEach((t, i) => {
    parts.push(`### [${i}] angle: \`${t.angle}\` — ${ANGLE_DESCRIPTIONS[t.angle]}`);
    parts.push('');
    parts.push('> ' + t.excerpt.split('\n').join('\n> '));
    parts.push('');
    parts.push(`Why it matters: ${t.rationale}`);
    parts.push('');
  });

  parts.push(
    `Write ${opts.count} candidate prompts for **each** of the ${opts.targets.length} targets above. ` +
      'Return one group per target, with its `target_index`.',
  );

  return parts.join('\n');
}

export function judgeBatchUser(opts: {
  folder: string;
  groups: {
    excerpt: string;
    angle: Angle;
    candidates: { front: string; back: string | null; type: string; justification: string }[];
  }[];
}): string {
  const parts = [
    `**Folder:** ${opts.folder}`,
    opts.folder === 'Ever Green Notes'
      ? '(Personal claim notes — the expert-response heuristic does NOT apply.)'
      : '(Technical notes — the expert-response heuristic applies.)',
    '',
  ];

  opts.groups.forEach((g, ti) => {
    parts.push(`# Target ${ti} — angle \`${g.angle}\``);
    parts.push('');
    parts.push('> ' + g.excerpt.split('\n').join('\n> '));
    parts.push('');
    g.candidates.forEach((c, ci) => {
      parts.push(`## target ${ti}, candidate ${ci} (type=${c.type})`);
      parts.push(`**Front:** ${c.front}`);
      parts.push(`**Back:** ${c.back ?? '(none — open/catechism card)'}`);
      parts.push(`**Its own justification:** ${c.justification}`);
      parts.push('');
    });
  });

  parts.push(
    'Return one verdict per candidate, keyed by `target_index` and `candidate_index`. Judge every one.',
  );
  return parts.join('\n');
}

export function stage2User(opts: {
  title: string;
  folder: string;
  content: string;
  excerpt: string;
  angle: Angle;
  rationale: string;
  count: number;
}): string {
  return [
    `# Target`,
    '',
    `**Span** (from "${opts.title}"):`,
    '',
    '> ' + opts.excerpt.split('\n').join('\n> '),
    '',
    `**Angle:** \`${opts.angle}\` — ${ANGLE_DESCRIPTIONS[opts.angle]}`,
    '',
    `**Why it's worth remembering:** ${opts.rationale}`,
    '',
    '---',
    '',
    folderGuidance(opts.folder),
    '',
    '## The full note, for context',
    '',
    '```markdown',
    opts.content,
    '```',
    '',
    `Write ${opts.count} candidate prompts for this span on this angle.`,
  ].join('\n');
}

export function judgeUser(opts: {
  excerpt: string;
  angle: Angle;
  folder: string;
  candidates: { front: string; back: string | null; type: string; justification: string }[];
}): string {
  const parts = [
    `# Source span`,
    '',
    '> ' + opts.excerpt.split('\n').join('\n> '),
    '',
    `**Angle:** \`${opts.angle}\` — ${ANGLE_DESCRIPTIONS[opts.angle]}`,
    `**Folder:** ${opts.folder}`,
    opts.folder === 'Ever Green Notes'
      ? '(Personal claim note — the expert-response heuristic does NOT apply.)'
      : '(Technical note — the expert-response heuristic applies.)',
    '',
    '# Candidates',
    '',
  ];

  opts.candidates.forEach((c, i) => {
    parts.push(`## [${i}] type=${c.type}`);
    parts.push(`**Front:** ${c.front}`);
    parts.push(`**Back:** ${c.back ?? '(none — open/catechism card)'}`);
    parts.push(`**Its own justification:** ${c.justification}`);
    parts.push('');
  });

  parts.push('Return one verdict per candidate, keyed by index.');
  return parts.join('\n');
}

export function stage1TargetedUser(opts: {
  title: string;
  folder: string;
  subfolder: string | null;
  content: string;
  request: string;
  linked: LinkedNote[];
  existingFronts: string[];
}): string {
  const parts: string[] = [];

  parts.push('# The request');
  parts.push('');
  parts.push('> ' + opts.request.trim().split('\n').join('\n> '));
  parts.push('');
  parts.push('Find exactly this in the note below. Nothing else.');
  parts.push('');
  parts.push('---');
  parts.push('');
  parts.push(`# Note: ${opts.title}`);
  parts.push(`Folder: ${opts.folder}${opts.subfolder ? ` / ${opts.subfolder}` : ''}`);
  parts.push('');
  parts.push(folderGuidance(opts.folder));
  parts.push('');
  parts.push('```markdown');
  parts.push(opts.content);
  parts.push('```');

  if (opts.linked.length) {
    parts.push('');
    parts.push('## Linked notes (context only — do not extract from these)');
    parts.push('');
    for (const l of opts.linked) {
      parts.push(`### ${l.title}`);
      parts.push(l.excerpt);
      parts.push('');
    }
  }

  if (opts.existingFronts.length) {
    parts.push('');
    parts.push('## Cards that already exist');
    parts.push('');
    parts.push(
      'He is asking because he believes these missed something. Do not re-propose what they cover:',
    );
    parts.push('');
    for (const f of opts.existingFronts) parts.push(`- ${f}`);
  }

  parts.push('');
  parts.push(
    'Propose the targets his request calls for — as many or as few as the material genuinely holds. ' +
      'If it holds none of what he asked for, return an empty list and say what the note covers instead.',
  );

  return parts.join('\n');
}
