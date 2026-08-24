import * as z from 'zod';
import { newCardState } from '../lib/fsrs';
import { readConfig, type Config } from '../lib/prompt-store';
import { complete, ollamaReady, providerOf } from './llm';
import { supabase } from '../lib/supabase';
import {
  zTargetBatch,
  zCandidateGroups,
  zBatchJudgement,
  zEquivalence,
  type Angle,
} from '../lib/types';
import { renderDiff } from './blocks';
import { emphasisWords, findEmphasis } from './emphasis';
import {
  DEDUP_SYSTEM,
  JUDGE_SYSTEM,
  STAGE1_SYSTEM,
  STAGE1_TARGETED_SYSTEM,
  STAGE2_SYSTEM,
  judgeBatchUser,
  stage1TargetedUser,
  stage1User,
  stage2BatchUser,
  type LinkedNote,
} from './prompts';
import type { NoteChange, SyncResult } from './sync';

/**
 * Models, per stage.
 *
 * The four stages don't need the same capability. Picking targets and judging cards are real
 * judgement calls; asking "are these two questions the same" is not. Sonnet 5 is the default —
 * near-Opus quality on this kind of work at a fraction of the price — with Haiku on the dedup
 * check, which is a binary comparison run at `effort: low`.
 *
 * `provider: 'ollama'` in the config swaps both for the local pair instead. The two are kept as
 * separate config fields rather than one, so flipping the switch back doesn't lose whichever
 * model names you had tuned on the other side.
 *
 * Override per stage with LOCI_MODEL / LOCI_MODEL_DEDUP if a run wants more or less; an env
 * override wins over the provider flag, which is what makes a one-off comparison run easy.
 */
let MODEL = process.env.LOCI_MODEL ?? 'claude-sonnet-5';
let MODEL_DEDUP = process.env.LOCI_MODEL_DEDUP ?? 'claude-haiku-4-5';

/**
 * List price per million tokens, [input, output].
 *
 * A model that isn't here is priced at zero, which is exactly right for a local one: the run
 * costs electricity, and reporting a fabricated dollar figure for it would be worse than
 * reporting nothing. A cloud Ollama model is also zero here — it bills against a subscription,
 * not per token, so there is no per-token rate to quote.
 */
const PRICING: Record<string, [number, number]> = {
  'claude-opus-5': [5, 25],
  'claude-sonnet-5': [3, 15], // introductory $2/$10 through 2026-08-31; quoting standard
  'claude-haiku-4-5': [1, 5],
};

/**
 * Tuning lives in `prompts/config.json`, editable from the methodology page.
 *
 * Coverage is proportional to substance — one target per `wordsPerTarget` words of changed text,
 * so a 3,000-word explainer yields dozens and a one-line edit yields one. Duplicate detection
 * runs in two bands: above `duplicateCertain` a candidate is dropped as a near-verbatim
 * restatement without asking, and between `duplicateGrey` and that it goes to the model, because
 * lexical similarity cannot tell "why do zero-shot scores do worst on stability assays?" from
 * "what explains poor zero-shot performance on ΔΔG?" — no shared trigrams, same card.
 */
let cfg: Config | null = null;
async function config(): Promise<Config> {
  // Read once per process. The scanner is short-lived, so this is per-run — edit the config in
  // the methodology page and the next scan picks it up.
  if (!cfg) cfg = await readConfig();
  return cfg;
}

export interface Usage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  calls: number;
  /** Per-model token totals, so a mixed-model run can be priced correctly. */
  byModel: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }>;
}

/**
 * `usage.input_tokens` is the *uncached remainder* only — total prompt size is
 * `input + cache_creation + cache_read`. Counting only the first field undercounts tokens and
 * overstates cost per token, so all three are tracked. The principles doc is ~8k tokens and
 * rides on every call, so cache reads should dominate within a run.
 */
function addUsage(
  total: Usage,
  model: string,
  u: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  },
) {
  const input = u.input_tokens;
  const output = u.output_tokens;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;

  total.input += input;
  total.output += output;
  total.cacheWrite += cacheWrite;
  total.cacheRead += cacheRead;
  total.calls += 1;

  const m = (total.byModel[model] ??= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
  m.input += input;
  m.output += output;
  m.cacheWrite += cacheWrite;
  m.cacheRead += cacheRead;
}

/** Cache writes bill at 1.25x the input rate, reads at 0.1x. */
export function estimateCost(u: Usage): number {
  let total = 0;
  for (const [model, m] of Object.entries(u.byModel)) {
    const [inRate, outRate] = PRICING[model] ?? PRICING['claude-sonnet-5'];
    total +=
      (m.input * inRate) / 1e6 +
      (m.cacheWrite * inRate * 1.25) / 1e6 +
      (m.cacheRead * inRate * 0.1) / 1e6 +
      (m.output * outRate) / 1e6;
  }
  return total;
}

export function modelsUsed(u: Usage): string {
  return Object.keys(u.byModel).join(' + ') || MODEL;
}

// ─────────────────────────────────────────────────────────────────────────────
// Local dedup
// ─────────────────────────────────────────────────────────────────────────────

function trigrams(s: string): Set<string> {
  const norm = ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const out = new Set<string>();
  for (let i = 0; i < norm.length - 2; i++) out.add(norm.slice(i, i + 3));
  return out;
}

/**
 * Jaccard similarity over character trigrams — the same shape as Postgres `pg_trgm`, computed
 * locally because the whole card set is a few hundred rows. Cheap enough to run per candidate
 * and it saves needing an embedding provider at all.
 */
export function similarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}

// ─────────────────────────────────────────────────────────────────────────────
// Model calls
// ─────────────────────────────────────────────────────────────────────────────

async function proposeTargets(
  change: NoteChange,
  ctx: {
    linked: LinkedNote[];
    existingFronts: string[];
    rejections: { original: string; reason: string }[];
    request?: string;
    emphasis: string[];
  },
  budget: number,
  usage: Usage,
) {
  // Two genuinely different jobs. A sweep covers the note proportionally; a targeted run answers
  // one specific request and treats anything else it finds as out of scope.
  const targeted = Boolean(ctx.request?.trim());

  const { parsed, usage: u } = await complete<z.infer<typeof zTargetBatch>>({
    stage: 'stage 1 (targets)',
    model: MODEL,
    schema: zTargetBatch,
    // Generous, because `max_tokens` bounds thinking + response together and a sweep over a
    // 3,000-word note legitimately produces a long structured answer.
    maxTokens: 32000,
    // `high` rather than `xhigh`: on Sonnet 5 the extra effort went almost entirely into thinking
    // tokens without reaching an answer. This is still the deepest setting in the pipeline.
    effort: (await config()).effortStage1,
    contextLimit: (await config()).ollamaContext,
    system: targeted ? await STAGE1_TARGETED_SYSTEM() : await STAGE1_SYSTEM(),
    user: targeted
      ? stage1TargetedUser({
          title: change.note.title,
          folder: change.note.folder,
          subfolder: change.note.subfolder,
          content: change.note.content,
          request: ctx.request!,
          linked: ctx.linked,
          existingFronts: ctx.existingFronts,
        })
      : stage1User({
          title: change.note.title,
          folder: change.note.folder,
          subfolder: change.note.subfolder,
          content: change.note.content,
          changedText: renderDiff(change.diff),
          isNew: change.kind === 'new',
          linked: ctx.linked,
          existingFronts: ctx.existingFronts,
          rejections: ctx.rejections,
          emphasis: ctx.emphasis,
          budget,
        }),
  });
  addUsage(usage, MODEL, u);
  return parsed;
}

async function writeCandidates(
  targets: { excerpt: string; angle: Angle; rationale: string }[],
  note: { title: string; folder: string; content: string },
  usage: Usage,
  request?: string,
) {
  const { parsed, usage: u } = await complete<z.infer<typeof zCandidateGroups>>({
    stage: 'stage 2 (cards)',
    model: MODEL,
    schema: zCandidateGroups,
    maxTokens: 48000,
    effort: (await config()).effortStage2,
    contextLimit: (await config()).ollamaContext,
    system: await STAGE2_SYSTEM(),
    user: stage2BatchUser({
      title: note.title,
      folder: note.folder,
      content: note.content,
      targets,
      count: (await config()).candidatesPerTarget,
      request,
    }),
  });
  addUsage(usage, MODEL, u);
  return parsed?.groups ?? [];
}

async function judge(
  folder: string,
  groups: {
    excerpt: string;
    angle: Angle;
    candidates: { front: string; back: string | null; type: string; justification: string }[];
  }[],
  usage: Usage,
) {
  const { parsed, usage: u } = await complete<z.infer<typeof zBatchJudgement>>({
    stage: 'stage 3 (judge)',
    model: MODEL,
    schema: zBatchJudgement,
    maxTokens: 32000,
    effort: (await config()).effortStage3,
    contextLimit: (await config()).ollamaContext,
    system: await JUDGE_SYSTEM(),
    user: judgeBatchUser({ folder, groups }),
  });
  addUsage(usage, MODEL, u);
  return parsed?.verdicts ?? [];
}

/**
 * Ask whether a candidate is already covered by one of its lexical near-neighbours.
 *
 * Only called for candidates that have a neighbour in the grey band, so on most cards this
 * costs nothing.
 */
async function checkDuplicate(
  candidate: { front: string; back: string | null },
  neighbours: { front: string; back: string | null }[],
  usage: Usage,
) {
  // Haiku 4.5 predates adaptive thinking and rejects `effort` outright, so the dedup call carries
  // neither. It doesn't need them: this is a single binary comparison, not a reasoning task.
  const cheap = MODEL_DEDUP.startsWith('claude-haiku');

  const { parsed, usage: u } = await complete<z.infer<typeof zEquivalence>>({
    stage: 'dedup',
    model: MODEL_DEDUP,
    schema: zEquivalence,
    maxTokens: 4000,
    ...(cheap ? { think: false } : { effort: 'low' as const }),
    contextLimit: (await config()).ollamaContext,
    system: await DEDUP_SYSTEM(),
    user: [
      '# Proposed card',
      `Q: ${candidate.front}`,
      `A: ${candidate.back ?? '(none)'}`,
      '',
      '# Existing cards in the deck',
      '',
      ...neighbours.flatMap((n, i) => [
        `## [${i}]`,
        `Q: ${n.front}`,
        `A: ${n.back ?? '(none)'}`,
        '',
      ]),
    ].join('\n'),
  });
  addUsage(usage, MODEL_DEDUP, u);
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractionSummary {
  targetsProposed: number;
  cardsProposed: number;
  duplicatesSkipped: number;
  usage: Usage;
  perNote: {
    title: string;
    targets: number;
    cards: number;
    /** Passages Joseph flagged with the emphasis marker. */
    flagged: number;
    skippedReason: string | null;
  }[];
}

export async function extract(
  sync: SyncResult,
  scanRunId: string,
  request?: string,
): Promise<ExtractionSummary> {
  const targeted = Boolean(request?.trim());

  // Env wins over the config file, so a one-off run can override without editing anything —
  // including the provider, since the model name is what decides it.
  const settings = await config();
  const local = settings.provider === 'ollama';
  MODEL = process.env.LOCI_MODEL ?? (local ? settings.ollamaModel : settings.model);
  MODEL_DEDUP = process.env.LOCI_MODEL_DEDUP ?? (local ? settings.ollamaModelDedup : settings.modelDedup);

  // Fail before touching the vault, not four notes in. A scan that dies partway has already
  // spent minutes on the diff, and on a local provider the most likely reason is the dullest
  // one — the model was never pulled.
  for (const m of new Set([MODEL, MODEL_DEDUP])) {
    if (providerOf(m) !== 'ollama') continue;
    const ready = await ollamaReady(m);
    if (!ready.ok) throw new Error(`Extraction is set to Ollama but ${ready.reason}`);
  }

  const db = supabase();
  const usage: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, calls: 0, byModel: {} };
  const perNote: ExtractionSummary['perNote'] = [];
  let targetsProposed = 0;
  let cardsProposed = 0;
  let duplicatesSkipped = 0;

  // Recent rejections become negative examples. This is the feedback loop: the extractor gets
  // sharper at Joseph's taste over weeks in a way no amount of up-front prompting can.
  const { data: rejectionRows } = await db
    .from('extraction_feedback')
    .select('original, reason')
    .in('kind', ['target_rejected', 'card_rejected'])
    .order('created_at', { ascending: false })
    .limit(12);
  const rejections = (rejectionRows ?? []).map((r) => ({
    original: (r.original as string) ?? '',
    reason: (r.reason as string) ?? '',
  }));

  // Every live card, for coverage context and dedup. A few hundred rows — cheap to hold.
  const { data: liveCards } = await db
    .from('cards')
    .select('id, front, back, note_id, angle')
    .in('status', ['proposed', 'active', 'suspended']);
  const live = (liveCards ?? []).map((c) => ({
    front: c.front as string,
    back: (c.back as string | null) ?? null,
    noteId: c.note_id as string,
    angle: c.angle as Angle,
  }));

  // Titles → content, so wikilinks can be resolved to real context.
  const { data: allNotes } = await db
    .from('notes')
    .select('id, title, content')
    .is('deleted_at', null);
  const byTitle = new Map((allNotes ?? []).map((n) => [n.title as string, n.content as string]));

  // Most-recently-edited first, so if a run is interrupted the freshest material is already done.
  const ordered = [...sync.changes].sort(
    (a, b) => b.note.mtime.getTime() - a.note.mtime.getTime(),
  );

  for (const change of ordered) {
    // "Learn before you memorize" — a stub is not a distillation of anything yet. A targeted run
    // still skips it, but the user picked this note deliberately, so say so rather than pass over.
    if (change.note.isStub) {
      await db.from('run_notes').insert({
        scan_run_id: scanRunId,
        note_id: change.noteId,
        note_title: change.note.title,
        note_path: change.note.path,
        kind: change.kind,
        words: change.note.wordCount,
        skipped_reason: 'stub note',
      });
      await change.commit();
      perNote.push({ title: change.note.title, targets: 0, cards: 0, flagged: 0, skippedReason: 'stub note' });
      continue;
    }
    if (!change.diff.added.length && !change.diff.changed.length) {
      perNote.push({
        title: change.note.title,
        targets: 0,
        cards: 0,
        flagged: 0,
        skippedReason: 'only removals',
      });
      await change.commit();
      continue;
    }

    const linked: LinkedNote[] = change.note.wikilinks
      .map((title) => ({ title, excerpt: (byTitle.get(title) ?? '').slice(0, 600) }))
      .filter((l) => l.excerpt.length > 0)
      .slice(0, 5);

    // What ground is already covered. Not just this note's cards — cards from anywhere in the
    // vault that are lexically close to this note's content, because the same concept gets
    // written about in several notes and stage 1 needs to see that it's already carded.
    const existingFronts = [
      ...live.filter((c) => c.noteId === change.noteId),
      ...live
        .filter((c) => c.noteId !== change.noteId)
        .map((c) => ({ ...c, sim: similarity(c.front, change.note.content) }))
        .filter((c) => c.sim > 0.05)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, (await config()).coverageContext),
    ].map((c) => `[${c.angle}] ${c.front}`);

    // Coverage scales with substance. Link-only and image-only blocks are stripped first — they
    // are exactly the material that shouldn't produce cards, so they shouldn't inflate the budget
    // either.
    const changedText = [...change.diff.added, ...change.diff.changed]
      .filter((b) => b.kind !== 'image')
      .map((b) => b.content)
      .join('\n')
      .replace(/!?\[\[[^\]]+\]\]/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ');
    const substantiveWords = changedText.split(/\s+/).filter((w) => /[a-z]/i.test(w)).length;
    const c = await config();

    // Anything Joseph flagged counts several times over towards the budget. Coverage is otherwise
    // purely proportional to length, which treats a throwaway aside and the paragraph he stopped
    // to mark as equally deserving — and the whole point of the marker is that they are not.
    const flagged = findEmphasis(changedText, c.emphasisMarker);
    const weighted = substantiveWords + emphasisWords(flagged) * (c.emphasisWeight - 1);
    const budget = Math.max(1, Math.min(c.targetsPerNoteMax, Math.round(weighted / c.wordsPerTarget)));

    const batch = await proposeTargets(
      change,
      { linked, existingFronts, rejections, request, emphasis: flagged.map((f) => f.text) },
      budget,
      usage,
    );
    // A sweep gets a word-proportional budget with a modest overshoot allowance. A targeted run
    // does not: how many targets a request warrants is set by the request, not by note length.
    const targets = targeted
      ? (batch?.targets ?? []).slice(0, c.targetsPerNoteMax)
      : (batch?.targets ?? []).slice(0, Math.ceil(budget * 1.5));

    if (!targets.length) {
      const reason = batch?.skipped_reason ?? 'no targets proposed';
      await db.from('run_notes').insert({
        scan_run_id: scanRunId,
        note_id: change.noteId,
        note_title: change.note.title,
        note_path: change.note.path,
        kind: change.kind,
        diff_text: changedText.slice(0, 20000),
        words: substantiveWords,
        skipped_reason: reason,
      });
      await change.commit();
      perNote.push({ title: change.note.title, targets: 0, cards: 0, flagged: 0, skippedReason: reason });
      continue;
    }

    const tags = [change.note.folder, ...(change.note.subfolder?.split('/') ?? [])].map((t) =>
      t.toLowerCase().replace(/\s+/g, '-'),
    );

    // Persist every target first, so a crash mid-note doesn't lose the expensive stage-1 work.
    const saved: { id: string; target: (typeof targets)[number]; blockHash: string | null }[] = [];
    for (const target of targets) {
      // Anchor to the block it came from, so a later edit to that block can flag it as stale.
      const sourceBlock =
        change.blocks.find((b) => b.content.includes(target.excerpt.slice(0, 60))) ?? null;

      const { data: row, error: targetError } = await db
        .from('targets')
        .insert({
          scan_run_id: scanRunId,
          note_id: change.noteId,
          // No block_id: block rows are replaced wholesale on every edit, so a foreign key would
          // dangle. `source_block_hash` is the stable anchor.
          excerpt: target.excerpt,
          angle: target.angle,
          rationale: target.rationale,
          connects_to: target.connects_to,
          source_block_hash: sourceBlock?.contentHash ?? null,
          // Targets are provenance now rather than a queue — the card they produced carries the
          // decision, and dropping that card is what records the rejection.
          status: 'approved',
        })
        .select('id')
        .single();
      if (targetError) throw new Error(`Failed to insert target: ${targetError.message}`);

      saved.push({ id: row.id as string, target, blockHash: sourceBlock?.contentHash ?? null });
      targetsProposed++;
    }

    let noteCards = 0;
    const cardedTargetIds = new Set<string>();

    // Write and judge in batches. Candidates are produced now rather than on approval so the
    // queue never waits on a model call; the ones whose targets get rejected are simply discarded.
    for (let start = 0; start < saved.length; start += c.batchSize) {
      const chunk = saved.slice(start, start + c.batchSize);

      const groups = await writeCandidates(
        chunk.map((s) => s.target),
        { title: change.note.title, folder: change.note.folder, content: change.note.content },
        usage,
        request,
      );
      if (!groups.length) continue;

      // Index defensively — a batched call can return groups out of order or skip one.
      const byIndex = new Map(groups.map((g) => [g.target_index, g.candidates]));
      const judgeGroups = chunk.map((s, i) => ({
        excerpt: s.target.excerpt,
        angle: s.target.angle,
        candidates: (byIndex.get(i) ?? []).map((c) => ({
          front: c.front,
          back: c.back,
          type: c.type,
          justification: c.justification,
        })),
      }));
      if (!judgeGroups.some((g) => g.candidates.length)) continue;

      const verdicts = await judge(change.note.folder, judgeGroups, usage);

      for (const [i, s] of chunk.entries()) {
        const candidates = byIndex.get(i) ?? [];
        if (!candidates.length) continue;

        const ranked = verdicts
          .filter(
            (v) =>
              v.target_index === i &&
              v.keep &&
              v.score >= c.keepScoreThreshold &&
              candidates[v.candidate_index],
          )
          .sort((a, b) => b.score - a.score)
          .slice(0, c.cardsPerTarget);

        for (const [rank, verdict] of ranked.entries()) {
          const candidate = candidates[verdict.candidate_index];

          const scored = live
            .map((c) => ({ ...c, sim: similarity(c.front, candidate.front) }))
            .sort((a, b) => b.sim - a.sim);

          // Band 1: near-verbatim. Drop without asking.
          if (scored[0] && scored[0].sim >= c.duplicateCertain) {
            duplicatesSkipped++;
            continue;
          }

          // Band 2: lexically adjacent but possibly a different angle on the same idea. Only the
          // model can settle that, and only these few need asking.
          const grey = scored.filter((x) => x.sim >= c.duplicateGrey).slice(0, 5);
          if (grey.length) {
            const dup = await checkDuplicate(
              { front: candidate.front, back: candidate.back },
              grey.map((c) => ({ front: c.front, back: c.back })),
              usage,
            );
            if (dup?.duplicate) {
              duplicatesSkipped++;
              continue;
            }
          }

          // Straight into the deck, with a schedule. There is no separate approval gate any
          // more: a card's first appearance in the New session is both its quality check and its
          // first retrieval attempt, so making you read it once to approve and again to review
          // was asking you to do the same work twice.
          const { data: savedCard, error: cardError } = await db
            .from('cards')
            .insert({
              target_id: s.id,
              note_id: change.noteId,
              type: candidate.type,
              angle: s.target.angle,
              front: candidate.front,
              back: candidate.back,
              cloze_text: candidate.cloze_text,
              context: candidate.context,
              tags,
              deck: change.note.folder,
              status: 'active',
              authored_by: 'model',
              source_excerpt: s.target.excerpt,
              source_block_hash: s.blockHash,
              candidate_rank: rank,
              judge_score: verdict.score,
              judge_notes: verdict.notes,
              approved_at: new Date().toISOString(),
            })
            .select('id')
            .single();
          if (cardError) throw new Error(`Failed to insert card: ${cardError.message}`);

          await db.from('card_states').insert(newCardState(savedCard.id as string));

          live.push({
            front: candidate.front,
            back: candidate.back,
            noteId: change.noteId,
            angle: s.target.angle,
          });
          cardedTargetIds.add(s.id);
          cardsProposed++;
          noteCards++;
        }
      }
    }

    // Any target whose candidates were all rejected is dead weight — it can never become a card,
    // and leaving it pending would put an empty decision in front of Joseph. Targets are inserted
    // before their cards for crash-safety, so this sweep is where that debt gets paid.
    const orphans = saved.filter((s) => !cardedTargetIds.has(s.id)).map((s) => s.id);
    if (orphans.length) {
      await db.from('targets').delete().in('id', orphans);
    }

    // Log the input alongside the output. Without the diff text a batch of weak cards is
    // unattributable — you cannot tell whether the extraction went wrong or the edit was thin.
    await db.from('run_notes').insert({
      scan_run_id: scanRunId,
      note_id: change.noteId,
      note_title: change.note.title,
      note_path: change.note.path,
      kind: change.kind,
      diff_text: changedText.slice(0, 20000),
      words: substantiveWords,
      targets_created: targets.length - orphans.length,
      cards_created: noteCards,
    });

    // This note is fully dealt with: accept its text as read. Anything after a cancellation
    // point stays pending and comes back on the next sync.
    await change.commit();

    perNote.push({
      title: change.note.title,
      targets: targets.length - orphans.length,
      cards: noteCards,
      flagged: flagged.length,
      skippedReason: null,
    });
  }

  return { targetsProposed, cardsProposed, duplicatesSkipped, usage, perNote };
}
