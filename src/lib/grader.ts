import 'server-only';
import { complete, providerReady, OLLAMA_MODEL } from './llm';
import { readConfig, readPrompt } from './prompt-store';
import { askedOf, type GraderStatus } from './grading';
import { ANGLE_DESCRIPTIONS, zRecallVerdict, type CardRow, type GradeResult } from './types';

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
