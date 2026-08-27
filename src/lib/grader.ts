import 'server-only';
import { complete, providerReady, OLLAMA_MODEL } from './llm';
import { readConfig, readPrompt } from './prompt-store';
import { askedOf, type GraderStatus } from './grading';
import {
  ANGLE_DESCRIPTIONS,
  zExplanation,
  zRecallVerdict,
  type CardRow,
  type Explanation,
  type ExplainResult,
  type GradeResult,
} from './types';

/**
 * The auto-grader: reads a typed recall attempt and puts one of the four grades on it.
 *
 * It runs on whichever provider `config.provider` names, like everything else here. The two are
 * priced very differently for this particular job — grading is the highest-frequency call in the
 * system, one per card per review forever, and also the easiest: compare a sentence against a
 * reference sentence. On Ollama it is free; on Anthropic it uses `modelDedup`, the cheap model,
 * for the same reason the duplicate check does.
 *
 * The transport lives in `llm.ts`. This file is only the prompt and what counts as an answer.
 */

export type { GraderStatus };

/** Which model grades, given the provider. */
async function graderModel(): Promise<string> {
  const cfg = await readConfig();
  return cfg.provider === 'ollama' ? OLLAMA_MODEL : cfg.modelDedup;
}

/**
 * Is there a grader to talk to?
 *
 * Asked before the review screen offers the typing box, so an unreachable provider shows up as a
 * greyed-out toggle with a sentence explaining why, rather than as a card that sits on
 * "grading…" until it times out.
 */
export async function graderStatus(): Promise<GraderStatus> {
  const model = await graderModel();
  const ready = await providerReady(model);
  return { available: ready.ok, reason: ready.reason ?? null, model };
}

type Card = Pick<CardRow, 'type' | 'front' | 'back' | 'cloze_text' | 'context' | 'angle'>;

/** Everything the grader is allowed to know, in the order it needs it. */
function brief(card: Card, typed: string): string {
  const { question, expected } = askedOf(card);
  const parts = [
    `The card asks:\n${question}`,
    `\nThe answer it was written to elicit:\n${expected}`,
    `\nThis card reinforces "${card.angle}" — ${ANGLE_DESCRIPTIONS[card.angle]}. That is what has to come back; nothing else about the topic is being tested.`,
  ];

  // Orientation the reviewer only sees *after* answering. Marked as such, or the model will
  // start expecting the answer to contain things it was never asked for.
  if (card.context) {
    parts.push(
      `\nBackground, shown only after the reveal (the answer does not need to contain any of it):\n${card.context}`,
    );
  }

  parts.push(`\nWhat was typed:\n${typed}`);
  return parts.join('\n');
}

/**
 * Grade one typed answer.
 *
 * Throws if the provider cannot be reached or will not produce a valid verdict. The caller turns
 * that into "self-grade this one" rather than a lost review — a card you have already answered
 * must never become un-gradeable because a background service died.
 */
export async function gradeAnswer(card: Card, typed: string): Promise<GradeResult> {
  const model = await graderModel();
  const started = Date.now();

  const answer = typed.trim();
  if (!answer) {
    // Nothing typed is a failed retrieval by definition. Spending a model call to be told so
    // would be slower and no more true.
    return {
      rating: 1,
      verdict: 'Nothing came back — you left the answer blank.',
      missing: 'the whole answer',
      model,
      latency_ms: 0,
    };
  }

  const { parsed } = await complete<GradeResult>({
    stage: 'grade',
    model,
    schema: zRecallVerdict,
    maxTokens: 1200,
    // Grading is a comparison, not a reasoning task, and `modelDedup` is a Haiku that rejects
    // `effort` outright — the same carve-out the duplicate check makes.
    think: false,
    system: await readPrompt('grade-answer'),
    user: brief(card, answer),
  });

  if (!parsed) throw new Error('The grader returned nothing.');
  return { ...parsed, model, latency_ms: Date.now() - started };
}

/**
 * Nothing to warm any more.
 *
 * A local model had to be read off disk before its first call, which cost the better part of
 * twenty seconds on the first card of a session. A hosted one does not, so this is a no-op kept
 * only so the review screen's opening fetch has somewhere to land.
 */
export async function warm(): Promise<void> {}

/**
 * The "explain this" button, for a card you got stuck on.
 *
 * Same provider switch as grading, same reason: this is an ungraded aside, not part of the
 * scored pipeline, so it belongs on the cheap model on either provider — `gpt-oss:120b` on
 * Ollama, `modelDedup` (Haiku) on Anthropic — not on whatever `model` extraction is currently
 * tuned to.
 */
async function explainerModel(): Promise<string> {
  const cfg = await readConfig();
  return cfg.provider === 'ollama' ? OLLAMA_MODEL : cfg.modelDedup;
}

/** Is there an explainer to talk to? Asked before the review screen enables the button. */
export async function explainerStatus(): Promise<GraderStatus> {
  const model = await explainerModel();
  const ready = await providerReady(model);
  return { available: ready.ok, reason: ready.reason ?? null, model };
}

type ExplainCard = Pick<CardRow, 'front' | 'back' | 'cloze_text' | 'context'>;

function explainBrief(card: ExplainCard): string {
  const parts = [
    `Card front: ${card.cloze_text ?? card.front}`,
    card.back ? `Card answer: ${card.back}` : null,
    card.context ? `Context: ${card.context}` : null,
    '',
    'Elaborate on the answer above — go deeper than the answer text itself.',
  ];
  return parts.filter(Boolean).join('\n');
}

export async function explainCard(card: ExplainCard): Promise<ExplainResult> {
  const model = await explainerModel();
  const started = Date.now();

  const { parsed } = await complete<Explanation>({
    stage: 'explain',
    model,
    schema: zExplanation,
    maxTokens: 400,
    // Same carve-out as grading: modelDedup is a Haiku that rejects `effort` outright, and this
    // is a short, low-stakes aside — not worth paying for thinking on either provider.
    think: false,
    system: await readPrompt('explain'),
    user: explainBrief(card),
  });

  if (!parsed) throw new Error('The explainer returned nothing.');
  return { ...parsed, model, latency_ms: Date.now() - started };
}
