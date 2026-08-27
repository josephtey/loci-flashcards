import * as z from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Angles — the reinforcement lens. Every target carries exactly one.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The foundational tier — plain recall.
 *
 * These were missing, and their absence was a mistake. Matuschak's manuscript lists "Simple
 * Facts" as its first pattern and says to begin with basic facts and notation on unfamiliar
 * topics before tackling relationships; I dropped that tier while optimising against rote, which
 * left the deck with only the top storey and no ground floor. You cannot reason about a drug
 * pipeline from first principles if you can't remember what ADMET stands for.
 */
export const FOUNDATIONAL_ANGLES = ['definition', 'fact', 'term'] as const;

export const CONCEPTUAL_ANGLES = [
  'attributes',
  'contrast',
  'parts-wholes',
  'causes-effects',
  'significance',
  'explanation',
] as const;

export const PROCEDURAL_ANGLES = ['transition', 'parameter', 'heuristic', 'rationale'] as const;

export const SALIENCE_ANGLES = ['salience', 'application', 'claim'] as const;

export const ANGLES = [
  ...FOUNDATIONAL_ANGLES,
  ...CONCEPTUAL_ANGLES,
  ...PROCEDURAL_ANGLES,
  ...SALIENCE_ANGLES,
] as const;

export type Angle = (typeof ANGLES)[number];

export const ANGLE_DESCRIPTIONS: Record<Angle, string> = {
  definition: 'what this term or entity is — the plain, retrievable meaning',
  fact: 'a specific durable value, name, quantity, or relationship worth having at hand',
  term: 'notation, nomenclature, or what an abbreviation expands to',
  attributes: 'what makes it fundamentally what it is; what is always/sometimes/never true',
  contrast: 'what relates it to and distinguishes it from an adjacent concept',
  'parts-wholes': 'sub-types, super-categories, what it is a part of',
  'causes-effects': 'what it does, what makes it do that, when it is used',
  significance: 'why it matters, what it implies, the "so what?"',
  explanation: 'WHY this is true, not what is true',
  transition: 'when you move from this step to the next, and what triggers it',
  parameter: 'the critical value, threshold, or condition',
  heuristic: 'how you recognise readiness, or that it worked',
  rationale: 'why this choice rather than the obvious alternative',
  salience: 'keeps the idea top-of-mind and applicable, rather than merely recalled',
  application: 'apply this lens to something recent (context deliberately vague)',
  claim: "Joseph's own position, its argument, and its strongest counter",
};

export const zAngle = z.enum(ANGLES);

// ─────────────────────────────────────────────────────────────────────────────
// Card shape. `type` is the interaction shape, not the subject.
// ─────────────────────────────────────────────────────────────────────────────

export const CARD_TYPES = ['qa', 'cloze', 'open'] as const;
export type CardType = (typeof CARD_TYPES)[number];
export const zCardType = z.enum(CARD_TYPES);

// ─────────────────────────────────────────────────────────────────────────────
// Stage 1 — reinforcement targets
// ─────────────────────────────────────────────────────────────────────────────

export const zTarget = z.object({
  excerpt: z
    .string()
    .describe('The span from the note worth reinforcing, quoted verbatim. One to three sentences.'),
  angle: zAngle.describe('Which aspect of this span to reinforce.'),
  rationale: z
    .string()
    .describe(
      'One sentence: why future-Joseph would be materially worse off for having forgotten this.',
    ),
  connects_to: z
    .array(z.string())
    .describe(
      'Titles of other notes in the vault this connects to. Empty array if genuinely isolated — ' +
        'an isolated target is a weaker candidate.',
    ),
});
export type TargetProposal = z.infer<typeof zTarget>;

export const zTargetBatch = z.object({
  targets: z.array(zTarget),
  skipped_reason: z
    .string()
    .nullable()
    .describe('If no targets were proposed, one sentence on why. Null otherwise.'),
});
export type TargetBatch = z.infer<typeof zTargetBatch>;

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2 — prompt candidates for an approved target
// ─────────────────────────────────────────────────────────────────────────────

export const zCandidate = z.object({
  type: zCardType,
  front: z.string().describe('The prompt shown. Short — long distinctive questions get pattern-matched.'),
  back: z
    .string()
    .nullable()
    .describe(
      'The answer. May be null for catechism-style open cards whose value is the recurring ' +
        'question rather than a fixed answer.',
    ),
  cloze_text: z
    .string()
    .nullable()
    .describe('For type="cloze" only: the text with {{c1::…}} deletions. Null otherwise.'),
  context: z
    .string()
    .nullable()
    .describe('One line of orientation, shown only after reveal. Null if unnecessary.'),
  justification: z
    .string()
    .describe(
      'How this prompt satisfies focused / precise / consistent / tractable / effortful, and ' +
        'whether it passes the expert-response heuristic.',
    ),
});
export type CardCandidate = z.infer<typeof zCandidate>;

export const zCandidateBatch = z.object({ candidates: z.array(zCandidate) });

/**
 * Batched stage 2: candidates for several targets in one call.
 *
 * A completeness pass produces tens of targets per note. One call per target re-sends the whole
 * principles document every time, which dominates both cost and wall-clock. Batching amortises it.
 */
export const zCandidateGroups = z.object({
  groups: z.array(
    z.object({
      target_index: z.number().int().describe('0-based index of the target these are for.'),
      candidates: z.array(zCandidate),
    }),
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage 3 — filter / rank
// ─────────────────────────────────────────────────────────────────────────────

export const zVerdict = z.object({
  index: z.number().int().describe('0-based index of the candidate being judged.'),
  keep: z.boolean(),
  score: z.number().describe('0-10. How much would future-Joseph thank you for this card?'),
  notes: z.string().describe('One sentence. If rejecting, name the specific property it fails.'),
});

export const zJudgement = z.object({ verdicts: z.array(zVerdict) });

export const zBatchJudgement = z.object({
  verdicts: z.array(
    z.object({
      target_index: z.number().int(),
      candidate_index: z.number().int(),
      keep: z.boolean(),
      score: z.number().describe('0-10. How much would future-Joseph thank you for this card?'),
      notes: z.string().describe('One sentence. If rejecting, name the property it fails.'),
    }),
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// Quick add — one pass, reviewed before it is saved
// ─────────────────────────────────────────────────────────────────────────────

export const zQuickCard = z.object({
  type: zCardType,
  angle: zAngle,
  front: z.string().describe('The prompt shown. Short — long distinctive questions get pattern-matched.'),
  back: z
    .string()
    .nullable()
    .describe('The answer. Null for a cloze card, whose text carries both sides.'),
  cloze_text: z
    .string()
    .nullable()
    .describe('For type="cloze": the sentence with {{c1::…}} deletions. Null otherwise.'),
  context: z.string().nullable().describe('One line of orientation, shown after the reveal.'),
  source_excerpt: z.string().describe('The span of the note this came from, quoted.'),
  rationale: z.string().describe('One sentence: why this is worth remembering.'),
});
export type QuickCard = z.infer<typeof zQuickCard>;

export const zQuickBatch = z.object({
  cards: z.array(zQuickCard),
  skipped_reason: z
    .string()
    .nullable()
    .describe('If few or no cards were written, what the notes actually cover. Null otherwise.'),
});

// ─────────────────────────────────────────────────────────────────────────────
// Duplicate detection
// ─────────────────────────────────────────────────────────────────────────────

export const zEquivalence = z.object({
  duplicate: z
    .boolean()
    .describe(
      'True if an existing card already covers this. The test is functional, not textual: ' +
        'would reviewing both feel like being asked the same thing twice?',
    ),
  of: z
    .number()
    .int()
    .nullable()
    .describe('0-based index of the existing card it duplicates, or null.'),
  reason: z.string().describe('One sentence.'),
});
export type Equivalence = z.infer<typeof zEquivalence>;

// ─────────────────────────────────────────────────────────────────────────────
// Ratings
// ─────────────────────────────────────────────────────────────────────────────

export const RATINGS = { Again: 1, Hard: 2, Good: 3, Easy: 4 } as const;
export type RatingValue = (typeof RATINGS)[keyof typeof RATINGS];
export const RATING_LABELS: Record<RatingValue, string> = {
  1: 'Again',
  2: 'Hard',
  3: 'Good',
  4: 'Easy',
};

export type StillEndorse = 'yes' | 'shifted' | 'no';

// ─────────────────────────────────────────────────────────────────────────────
// Auto-grading a typed answer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the local model returns after reading a typed recall attempt.
 *
 * The field order is load-bearing, not cosmetic. Structured output constrains generation
 * token by token in the order the schema declares, so a model that emits `rating` first has
 * committed to a number before it has written a word about what happened — which is exactly
 * the reasoning we want it to do. `verdict` and `missing` come first so the number is the
 * conclusion of the thought rather than a guess the prose then rationalises.
 */
export const zRecallVerdict = z.object({
  verdict: z.string().describe('One sentence, second person: what came back and what did not.'),
  missing: z
    .string()
    .describe('The specific thing the answer left out, in a few words. Empty if nothing.'),
  rating: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
    .describe('1 Again, 2 Hard, 3 Good, 4 Easy.'),
});
export type RecallVerdict = z.infer<typeof zRecallVerdict>;

/** A verdict plus what it cost to get, which is what the calibration view reads. */
export interface GradeResult extends RecallVerdict {
  model: string;
  latency_ms: number;
}

export const zExplanation = z.object({
  explanation: z.string().describe('Two or three sentences, plain language, prose only.'),
});
export type Explanation = z.infer<typeof zExplanation>;

/** An explanation plus what it cost to get, the same shape as `GradeResult`. */
export interface ExplainResult extends Explanation {
  model: string;
  latency_ms: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes (hand-written rather than generated; the schema is small and stable)
// ─────────────────────────────────────────────────────────────────────────────

export interface NoteRow {
  id: string;
  path: string;
  title: string;
  folder: string;
  subfolder: string | null;
  content: string;
  content_hash: string;
  frontmatter: Record<string, unknown>;
  wikilinks: string[];
  embeds: string[];
  word_count: number;
  is_stub: boolean;
  mtime: string | null;
  last_changed_at: string;
  deleted_at: string | null;
}

export interface TargetRow {
  id: string;
  scan_run_id: string | null;
  note_id: string;
  block_id: string | null;
  excerpt: string;
  angle: Angle;
  rationale: string;
  connects_to: string[];
  source_block_hash: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  reject_reason: string | null;
  created_at: string;
}

export interface CardRow {
  id: string;
  target_id: string | null;
  note_id: string;
  type: CardType;
  angle: Angle;
  front: string;
  back: string | null;
  cloze_text: string | null;
  context: string | null;
  tags: string[];
  deck: string;
  status: 'proposed' | 'active' | 'suspended' | 'retired' | 'needs_rewrite';
  authored_by: 'model' | 'human' | 'edited';
  source_excerpt: string | null;
  candidate_rank: number | null;
  judge_score: number | null;
  judge_notes: string | null;
  created_at: string;
}

export interface CardStateRow {
  card_id: string;
  due: string;
  stability: number | null;
  difficulty: number | null;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: 0 | 1 | 2 | 3;
  last_review: string | null;
  skip_count: number;
  skipped_until: string | null;
}

export type DueCard = CardRow & Omit<CardStateRow, 'card_id'> & {
  note_title: string;
  note_path: string;
};
