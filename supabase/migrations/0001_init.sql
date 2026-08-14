-- Loci — spaced repetition memory system sourced from an Obsidian vault.
--
-- Design notes (see docs/prompt-principles.md for the why):
--   * Content (cards) / schedule (card_states) / history (reviews) are three tables, not one.
--     Editing a card's wording must not touch its schedule, and the append-only review log is
--     the actual asset — it's what lets us re-fit FSRS parameters on Joseph's own data later.
--   * `targets` is the unit of triage. Stage 1 proposes targets; stage 2 writes prompts for them.
--     Identifying what deserves a prompt is the harder problem and the one the model is worst at,
--     so that's where the human sits.
--   * All access is server-side with the secret key. RLS is on with no policies = deny-all for
--     the anon/publishable key. The browser never talks to Postgres directly.

create extension if not exists pg_trgm;

-- ─────────────────────────────────────────────────────────────────────────────
-- Vault mirror
-- ─────────────────────────────────────────────────────────────────────────────

create table notes (
  id                uuid primary key default gen_random_uuid(),
  path              text not null unique,           -- relative to vault root
  title             text not null,                  -- filename sans .md
  folder            text not null,                  -- 'Ever Green Learnings' | 'Ever Green Notes'
  subfolder         text,                           -- 'AI/Interpretability', null at folder root
  content           text not null,                  -- body, frontmatter stripped
  content_hash      text not null,                  -- sha256 of content
  frontmatter       jsonb not null default '{}'::jsonb,
  wikilinks         text[] not null default '{}',   -- [[resolved titles]], excludes ![[embeds]]
  embeds            text[] not null default '{}',   -- ![[images]] — flags image-dependent content
  word_count        integer not null default 0,
  is_stub           boolean not null default false, -- too thin to card
  mtime             timestamptz,
  first_seen_at     timestamptz not null default now(),
  last_changed_at   timestamptz not null default now(),
  deleted_at        timestamptz
);

create index notes_folder_idx on notes (folder) where deleted_at is null;
create index notes_last_changed_idx on notes (last_changed_at desc);

-- Semantic chunks within a note. The diff engine works at this granularity so that editing
-- one line of a 40-line note doesn't re-propose targets for the untouched 39.
create table note_blocks (
  id            uuid primary key default gen_random_uuid(),
  note_id       uuid not null references notes(id) on delete cascade,
  idx           integer not null,                   -- order within note
  content       text not null,
  content_hash  text not null,
  heading_path  text,                               -- 'Foo > Bar' from surrounding headings
  kind          text not null check (kind in ('paragraph','list','heading','code','quote','table','image')),
  created_at    timestamptz not null default now(),
  unique (note_id, idx)
);

create index note_blocks_hash_idx on note_blocks (content_hash);

-- ─────────────────────────────────────────────────────────────────────────────
-- Extraction
-- ─────────────────────────────────────────────────────────────────────────────

create table scan_runs (
  id                uuid primary key default gen_random_uuid(),
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  status            text not null default 'running' check (status in ('running','completed','failed')),
  trigger           text not null default 'manual' check (trigger in ('manual','cron')),
  notes_scanned     integer not null default 0,
  notes_new         integer not null default 0,
  notes_changed     integer not null default 0,
  notes_deleted     integer not null default 0,
  targets_proposed  integer not null default 0,
  cards_proposed    integer not null default 0,
  model             text,
  input_tokens      integer not null default 0,
  output_tokens     integer not null default 0,
  error             text
);

-- The 13 reinforcement angles. Stage 2 writes to the angle; the human can correct it in one tap.
create type angle as enum (
  -- conceptual
  'attributes', 'contrast', 'parts-wholes', 'causes-effects', 'significance', 'explanation',
  -- procedural
  'transition', 'parameter', 'heuristic', 'rationale',
  -- salience / identity
  'salience', 'application', 'claim'
);

-- A reinforcement target: a span worth remembering, plus which angle on it to reinforce.
-- This is what gets triaged first.
create table targets (
  id                uuid primary key default gen_random_uuid(),
  scan_run_id       uuid references scan_runs(id) on delete set null,
  note_id           uuid not null references notes(id) on delete cascade,
  block_id          uuid references note_blocks(id) on delete set null,
  excerpt           text not null,                  -- the span, verbatim from the note
  angle             angle not null,
  rationale         text not null,                  -- one line: why future-Joseph wants this
  connects_to       text[] not null default '{}',   -- other note titles this relates to (anti-orphan)
  source_block_hash text,                           -- drift detection
  status            text not null default 'pending'
                      check (status in ('pending','approved','rejected','superseded')),
  reject_reason     text,
  reviewed_at       timestamptz,
  created_at        timestamptz not null default now()
);

create index targets_status_idx on targets (status, created_at desc);
create index targets_note_idx on targets (note_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Cards
-- ─────────────────────────────────────────────────────────────────────────────

-- type is the interaction shape, not the subject:
--   qa    — front asks, back answers. The default.
--   cloze — {{c1::…}} deletions. Narrow: closed-list enumeration only.
--   open  — free recall; `back` may be gestural or null (catechism cards have no back).
create table cards (
  id                uuid primary key default gen_random_uuid(),
  target_id         uuid references targets(id) on delete set null,
  note_id           uuid not null references notes(id) on delete cascade,
  type              text not null check (type in ('qa','cloze','open')),
  angle             angle not null,
  front             text not null,
  back              text,                           -- nullable by design
  cloze_text        text,                           -- for type='cloze'
  context           text,                           -- orientation shown only after reveal
  tags              text[] not null default '{}',   -- derived from folder path
  deck              text not null default 'default',
  status            text not null default 'proposed'
                      check (status in ('proposed','active','suspended','retired','needs_rewrite')),
  authored_by       text not null default 'model' check (authored_by in ('model','human','edited')),
  model_original    jsonb,                          -- the model's version, when a human edited it
  source_excerpt    text,
  source_block_hash text,
  candidate_rank    integer,                        -- which of N generated candidates
  judge_score       numeric,                        -- filter pass score
  judge_notes       text,
  reject_reason     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  approved_at       timestamptz,
  constraint cloze_has_text check (type <> 'cloze' or cloze_text is not null)
);

create index cards_status_idx on cards (status, created_at desc);
create index cards_target_idx on cards (target_id);
create index cards_note_idx on cards (note_id);
-- Dedup: trigram similarity on `front` finds near-duplicate candidates cheaply, and an LLM
-- equivalence check confirms. Avoids needing an embedding provider at all.
create index cards_front_trgm_idx on cards using gin (front gin_trgm_ops);

-- FSRS scheduling state. Separate from content so a wording edit never disturbs the schedule.
-- `state` follows the ts-fsrs State enum: 0 New, 1 Learning, 2 Review, 3 Relearning.
create table card_states (
  card_id         uuid primary key references cards(id) on delete cascade,
  due             timestamptz not null default now(),
  stability       real,
  difficulty      real,
  elapsed_days    integer not null default 0,
  scheduled_days  integer not null default 0,
  learning_steps  integer not null default 0,
  reps            integer not null default 0,
  lapses          integer not null default 0,
  state           smallint not null default 0,
  last_review     timestamptz,
  -- Skip defers with exponential backoff; it never deletes. Kornell & Bjork (2008) and
  -- Whitmer (2020) both show that letting people drop cards hurts learning.
  skip_count      integer not null default 0,
  skipped_until   timestamptz,
  updated_at      timestamptz not null default now()
);

create index card_states_due_idx on card_states (due);

-- Append-only. Never updated, never deleted. Everything else is derived from this.
create table reviews (
  id             bigserial primary key,
  card_id        uuid not null references cards(id) on delete cascade,
  action         text not null default 'grade'
                   check (action in ('grade','skip','flag_bad')),
  rating         smallint check (rating between 1 and 4),  -- 1 Again 2 Hard 3 Good 4 Easy
  still_endorse  text check (still_endorse in ('yes','shifted','no')),  -- angle='claim' only
  state_before   jsonb not null,
  state_after    jsonb,
  duration_ms    integer,
  reviewed_at    timestamptz not null default now(),
  scheduler      text not null default 'fsrs',
  scheduler_version text,
  constraint grade_has_rating check (action <> 'grade' or rating is not null)
);

create index reviews_card_idx on reviews (card_id, reviewed_at desc);
create index reviews_time_idx on reviews (reviewed_at desc);

-- Rejections and edits become negative examples for the next night's extraction prompt.
create table extraction_feedback (
  id          uuid primary key default gen_random_uuid(),
  target_id   uuid references targets(id) on delete cascade,
  card_id     uuid references cards(id) on delete cascade,
  kind        text not null check (kind in
                ('target_rejected','target_angle_changed','card_rejected','card_edited','card_flagged_bad')),
  reason      text,
  original    text,                                 -- what the model produced
  corrected   text,                                 -- what Joseph replaced it with
  created_at  timestamptz not null default now()
);

create index extraction_feedback_recent_idx on extraction_feedback (created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- Views
-- ─────────────────────────────────────────────────────────────────────────────

create view due_cards as
  select c.*, s.due, s.stability, s.difficulty, s.reps, s.lapses, s.state, s.last_review,
         s.skip_count, s.skipped_until, n.title as note_title, n.path as note_path
  from cards c
  join card_states s on s.card_id = c.id
  join notes n on n.id = c.note_id
  where c.status = 'active'
    and s.due <= now()
    and (s.skipped_until is null or s.skipped_until <= now());

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: deny-all. Everything goes through the server with the secret key.
-- ─────────────────────────────────────────────────────────────────────────────

alter table notes                enable row level security;
alter table note_blocks          enable row level security;
alter table scan_runs            enable row level security;
alter table targets              enable row level security;
alter table cards                enable row level security;
alter table card_states          enable row level security;
alter table reviews              enable row level security;
alter table extraction_feedback  enable row level security;
