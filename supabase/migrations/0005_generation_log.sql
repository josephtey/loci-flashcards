-- 0005 — a log of what each generation actually read.
--
-- `scan_runs` records totals: how many notes, how many cards, what it cost. That answers "did it
-- run" but not "what did it run on", so a card in the deck cannot be traced back to the edit that
-- produced it. This table keeps the diff text itself, per note per run — the input alongside the
-- output, which is the only way to look at a batch of weak cards and see whether the extraction
-- was wrong or the source material was just thin.
--
-- Also records the scope a run was given, so a filtered run reads back as deliberate rather than
-- as a run that mysteriously skipped most of the vault.

create table if not exists run_notes (
  id              uuid primary key default gen_random_uuid(),
  scan_run_id     uuid not null references scan_runs(id) on delete cascade,
  note_id         uuid references notes(id) on delete set null,
  note_title      text not null,
  note_path       text not null,
  kind            text not null check (kind in ('new', 'changed')),
  -- The added/edited blocks, exactly as they were handed to the model.
  diff_text       text not null default '',
  words           integer not null default 0,
  targets_created integer not null default 0,
  cards_created   integer not null default 0,
  skipped_reason  text,
  created_at      timestamptz not null default now()
);

create index if not exists run_notes_run_idx on run_notes (scan_run_id, created_at);
create index if not exists run_notes_note_idx on run_notes (note_id);

alter table run_notes enable row level security;

-- What the run was pointed at, and what was asked of it.
alter table scan_runs add column if not exists scope text;
alter table scan_runs add column if not exists request text;

-- ── folded in from 0004, in case it was not run ──────────────────────────────
alter table cards alter column note_id drop not null;

drop view if exists due_cards;
create view due_cards as
  select c.*, s.due, s.stability, s.difficulty, s.reps, s.lapses, s.state, s.last_review,
         s.skip_count, s.skipped_until, n.title as note_title, n.path as note_path
  from cards c
  join card_states s on s.card_id = c.id
  left join notes n on n.id = c.note_id
  where c.status = 'active'
    and s.due <= now()
    and (s.skipped_until is null or s.skipped_until <= now());

alter table reviews drop constraint if exists reviews_action_check;
alter table reviews add constraint reviews_action_check
  check (action in ('grade', 'skip', 'flag_bad', 'drop'));

-- ── a run you can see and stop ───────────────────────────────────────────────
-- A scan that dies mid-flight leaves its row saying 'running' forever, which reads as a phantom
-- job in the UI. Recording the pid lets the app check whether the process is actually alive.
alter table scan_runs add column if not exists pid integer;
alter table scan_runs drop constraint if exists scan_runs_status_check;
alter table scan_runs add constraint scan_runs_status_check
  check (status in ('running', 'completed', 'failed', 'cancelled'));
