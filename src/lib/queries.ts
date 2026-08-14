import 'server-only';
import { DAILY_REVIEW_CAP } from './goals';
import { supabase } from './supabase';
import type { Angle, CardType, DueCard, StillEndorse } from './types';

export interface QueueCard {
  id: string;
  type: CardType;
  front: string;
  back: string | null;
  cloze_text: string | null;
  context: string | null;
  judge_score: number | null;
  judge_notes: string | null;
  candidate_rank: number | null;
}

export interface QueueItem {
  id: string;
  excerpt: string;
  angle: Angle;
  rationale: string;
  connects_to: string[];
  created_at: string;
  note: { id: string; title: string; path: string; folder: string; subfolder: string | null };
  cards: QueueCard[];
}

interface TargetRowLite {
  id: string;
  note_id: string;
  excerpt: string;
  angle: Angle;
  rationale: string;
  connects_to: string[] | null;
  created_at: string;
}

export async function pendingTargets(): Promise<QueueItem[]> {
  const db = supabase();

  // Two round trips rather than a PostgREST embed. Without generated database types the embed
  // syntax defeats the client's inference, and the join is a handful of rows either way.
  const { data: targetRows, error } = await db
    .from('targets')
    .select('id, note_id, excerpt, angle, rationale, connects_to, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);

  const targets = (targetRows ?? []) as unknown as TargetRowLite[];
  if (!targets.length) return [];

  const { data: noteRows } = await db
    .from('notes')
    .select('id, title, path, folder, subfolder')
    .in('id', [...new Set(targets.map((t) => t.note_id))]);
  const notes = new Map(
    ((noteRows ?? []) as unknown as QueueItem['note'][]).map((n) => [n.id, n]),
  );

  const ids = targets.map((t) => t.id);
  const { data: cards } = await db
    .from('cards')
    .select('id, target_id, type, front, back, cloze_text, context, judge_score, judge_notes, candidate_rank')
    .in('target_id', ids)
    .eq('status', 'proposed')
    .order('candidate_rank', { ascending: true });

  const byTarget = new Map<string, QueueCard[]>();
  for (const c of cards ?? []) {
    const list = byTarget.get(c.target_id as string) ?? [];
    list.push(c as unknown as QueueCard);
    byTarget.set(c.target_id as string, list);
  }

  return targets.flatMap((t) => {
    const note = notes.get(t.note_id);
    if (!note) return []; // note deleted between the two reads

    // A target with no card is never a decision worth showing. It means either that a scan is
    // still mid-flight — targets are persisted before their cards are written, so there's a
    // window where they exist bare — or that the judge rejected every candidate. Neither is
    // something to interrupt triage with.
    const drafts = byTarget.get(t.id) ?? [];
    if (!drafts.length) return [];

    return [
      {
        id: t.id,
        excerpt: t.excerpt,
        angle: t.angle,
        rationale: t.rationale,
        connects_to: t.connects_to ?? [],
        created_at: t.created_at,
        note,
        cards: drafts,
      },
    ];
  });
}

/**
 * Two sessions, split by whether a card has ever been graded.
 *
 * `New` is a card's first encounter — the session where it is both established and vetted, since
 * you can drop it there. `Review` is everything you have already met at least once. Splitting on
 * `reps` rather than on a status flag means the boundary is a fact about your history with the
 * card, not a piece of workflow state that could drift out of sync.
 */
export async function newCards(limit = 40): Promise<DueCard[]> {
  const db = supabase();
  const { data, error } = await db
    .from('due_cards')
    .select('*')
    .eq('reps', 0)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as DueCard[];
}

export async function dueCards(limit = 60): Promise<DueCard[]> {
  const db = supabase();
  const { data, error } = await db
    .from('due_cards')
    .select('*')
    .gt('reps', 0)
    .order('due', { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as DueCard[];
}

export interface Counts {
  newCards: number;
  dueNow: number;
  activeCards: number;
  droppedCards: number;
  needsRewrite: number;
  reviewsToday: number;
  lastScan: { finished_at: string | null; status: string; cards_proposed: number } | null;
}

export async function counts(): Promise<Counts> {
  const db = supabase();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const head = { count: 'exact' as const, head: true };
  const [fresh, due, active, dropped, rewrite, reviews, scan] = await Promise.all([
    db.from('due_cards').select('id', head).eq('reps', 0),
    db.from('due_cards').select('id', head).gt('reps', 0),
    db.from('cards').select('id', head).eq('status', 'active'),
    db.from('cards').select('id', head).eq('status', 'retired'),
    db.from('cards').select('id', head).eq('status', 'needs_rewrite'),
    db.from('reviews').select('id', head).gte('reviewed_at', startOfDay.toISOString()),
    db
      .from('scan_runs')
      .select('finished_at, status, cards_proposed')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  return {
    newCards: fresh.count ?? 0,
    dueNow: due.count ?? 0,
    activeCards: active.count ?? 0,
    droppedCards: dropped.count ?? 0,
    needsRewrite: rewrite.count ?? 0,
    reviewsToday: reviews.count ?? 0,
    lastScan: (scan.data as Counts['lastScan']) ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Browse
// ─────────────────────────────────────────────────────────────────────────────

export interface BrowseCard {
  id: string;
  front: string;
  back: string | null;
  cloze_text: string | null;
  type: CardType;
  angle: Angle;
  status: string;
  authored_by: string;
  judge_score: number | null;
  created_at: string;
  /** Null when a card has no schedule — i.e. it was dropped before it ever entered the deck. */
  due: string | null;
  stability: number | null;
  reps: number;
  lapses: number;
  state: number;
  last_review: string | null;
}

export interface BrowseNote {
  id: string;
  title: string;
  path: string;
  folder: string;
  subfolder: string | null;
  wordCount: number;
  cards: BrowseCard[];
}

/**
 * Every card, grouped by the note it came from, with its memory state attached.
 *
 * The state is the point: a list of cards tells you what exists, but `reps`, `lapses` and
 * `stability` tell you what is actually holding. A note whose cards all sit at zero reps has
 * been extracted but never learned; one with repeated lapses is telling you the prompts are
 * wrong, not that your memory is.
 */
export async function browseByNote(): Promise<BrowseNote[]> {
  const db = supabase();

  const [{ data: noteRows }, { data: cardRows }, { data: stateRows }] = await Promise.all([
    db.from('notes').select('id, title, path, folder, subfolder, word_count').is('deleted_at', null),
    db
      .from('cards')
      .select(
        'id, note_id, front, back, cloze_text, type, angle, status, authored_by, judge_score, created_at',
      )
      .order('created_at', { ascending: true }),
    db
      .from('card_states')
      .select('card_id, due, stability, reps, lapses, state, last_review'),
  ]);

  const states = new Map(
    (stateRows ?? []).map((s) => [s.card_id as string, s as Record<string, unknown>]),
  );

  const STANDALONE = '__standalone__';
  const byNote = new Map<string, BrowseCard[]>();
  for (const c of cardRows ?? []) {
    const st = states.get(c.id as string);
    const key = (c.note_id as string | null) ?? STANDALONE;
    const list = byNote.get(key) ?? [];
    list.push({
      id: c.id as string,
      front: c.front as string,
      back: (c.back as string | null) ?? null,
      cloze_text: (c.cloze_text as string | null) ?? null,
      type: c.type as CardType,
      angle: c.angle as Angle,
      status: c.status as string,
      authored_by: c.authored_by as string,
      judge_score: (c.judge_score as number | null) ?? null,
      created_at: c.created_at as string,
      due: (st?.due as string | null) ?? null,
      stability: (st?.stability as number | null) ?? null,
      reps: (st?.reps as number) ?? 0,
      lapses: (st?.lapses as number) ?? 0,
      state: (st?.state as number) ?? 0,
      last_review: (st?.last_review as string | null) ?? null,
    });
    byNote.set(key, list);
  }

  const standalone = byNote.get(STANDALONE) ?? [];

  return ((noteRows ?? []) as unknown as Record<string, unknown>[])
    .map((n) => ({
      id: n.id as string,
      title: n.title as string,
      path: n.path as string,
      folder: n.folder as string,
      subfolder: (n.subfolder as string | null) ?? null,
      wordCount: (n.word_count as number) ?? 0,
      cards: byNote.get(n.id as string) ?? [],
    }))
    .filter((n) => n.cards.length > 0)
    .sort((a, b) => b.cards.length - a.cards.length)
    .concat(
      // Cards you wrote yourself sit at the end under a group of their own — grouping is by
      // source, and "no source" is a real answer rather than a missing one.
      standalone.length
        ? [
            {
              id: STANDALONE,
              title: 'Written by hand',
              path: '',
              folder: '',
              subfolder: null,
              wordCount: 0,
              cards: standalone,
            },
          ]
        : [],
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity
// ─────────────────────────────────────────────────────────────────────────────

export interface Activity {
  /** One entry per day, oldest first, covering the last 52 weeks. */
  days: {
    date: string;
    reviews: number;
    learned: number;
    /** Cards that were due at the end of this day and hadn't been reviewed. */
    owed: number;
    /** Nothing left owed — or the daily cap was reached, which discharges the day either way. */
    met: boolean;
  }[];
  streak: number;
  longestStreak: number;
  todayReviews: number;
  todayLearned: number;
}

/**
 * Daily review counts, and the streak they add up to.
 *
 * A day counts if anything was reviewed at all — one card is enough. The point of a streak is to
 * make showing up cheap: a bar set at "did my full quota" turns one busy evening into a broken
 * chain and, in practice, into an abandoned deck.
 */
export async function activity(): Promise<Activity> {
  const db = supabase();

  const since = new Date();
  since.setDate(since.getDate() - 364);
  since.setHours(0, 0, 0, 0);

  const dayKey = (d: string | Date) =>
    (typeof d === 'string' ? new Date(d) : d).toLocaleDateString('en-CA');

  const [{ data }, { data: states }] = await Promise.all([
    db
      .from('reviews')
      .select('reviewed_at, state_before, action')
      .gte('reviewed_at', since.toISOString())
      .order('reviewed_at', { ascending: true }),
    // Anything still sitting overdue is a debt that was never discharged — it has to count
    // against every day it was outstanding, not just today.
    db.from('card_states').select('due, reps').gt('reps', 0),
  ]);

  const byDay = new Map<string, { reviews: number; learned: number }>();

  /**
   * Every stretch where a card was due and unreviewed, as [owed from, cleared on).
   *
   * This is what makes the streak mean something. Counting days with any activity rewards
   * showing up; counting days that ended with nothing owed rewards actually keeping up, which is
   * the thing that protects the memories. New cards are deliberately excluded — they are elastic,
   * and a day spent not learning something new costs nothing you already had.
   */
  const opened = new Map<string, number>();
  const closed = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const floor = dayKey(since);

  for (const r of data ?? []) {
    const before = r.state_before as { reps?: number; due?: string } | null;

    if (r.action === 'grade') {
      const key = dayKey(r.reviewed_at as string);
      const e = byDay.get(key) ?? { reviews: 0, learned: 0 };
      e.reviews++;
      // A grade whose prior state had no reps is a card met for the first time.
      if (!before?.reps) e.learned++;
      byDay.set(key, e);
    }

    if (!before?.reps || !before.due) continue;
    const from = dayKey(before.due);
    const to = dayKey(r.reviewed_at as string);
    if (to <= from) continue; // reviewed early — it was never a debt
    bump(opened, from < floor ? floor : from);
    bump(closed, to);
  }

  for (const st of states ?? []) {
    const from = dayKey(st.due as string);
    bump(opened, from < floor ? floor : from);
  }

  const days: Activity['days'] = [];
  const cursor = new Date(since);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let outstanding = 0;
  while (cursor <= today) {
    const key = dayKey(cursor);
    const e = byDay.get(key) ?? { reviews: 0, learned: 0 };
    outstanding += opened.get(key) ?? 0;
    outstanding -= closed.get(key) ?? 0;
    const owed = Math.max(0, outstanding);
    days.push({
      date: key,
      ...e,
      owed,
      // Forty is a full sitting. Past that the day is discharged whatever the backlog says —
      // otherwise digging out of a pile marks every day of the dig as a failure. Learning new
      // cards doesn't count towards it: meeting ninety new cards while ignoring what was due is
      // the opposite of keeping up, however much work it was.
      met: owed === 0 || e.reviews - e.learned >= DAILY_REVIEW_CAP,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  // Before the deck existed, every day trivially owed nothing — which would credit a 365-day
  // streak to someone who started yesterday. History starts at the first day with a card in it.
  const began = days.findIndex((d) => d.reviews > 0 || d.owed > 0);
  for (let i = 0; i < (began === -1 ? days.length : began); i++) days[i].met = false;

  // Today isn't over, so a day that hasn't been cleared *yet* shouldn't read as a broken streak.
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].met) streak++;
    else if (i === days.length - 1) continue;
    else break;
  }

  let longest = 0;
  let run = 0;
  for (const d of days) {
    if (d.met) run++;
    else run = 0;
    if (run > longest) longest = run;
  }

  const last = days[days.length - 1];
  return {
    days,
    streak,
    longestStreak: longest,
    todayReviews: last?.reviews ?? 0,
    todayLearned: last?.learned ?? 0,
  };
}


export type { Angle, CardType, DueCard, StillEndorse };
