-- 0002 — completeness pass
--
-- Two changes:
--
-- 1. `angle` becomes text rather than an enum. The taxonomy is still being tuned — a foundational
--    tier (definition / fact / term) was just added and more will follow — and every change to an
--    enum is a migration you have to go and paste into a dashboard. Text with the constraint
--    enforced in application code is the right trade while the vocabulary is still moving.
--
-- 2. Reset. Clears every card, target, note snapshot and scan so the next run starts from a clean
--    vault read. Deliberately destructive: run this only when you mean to start over.
--
-- `due_cards` selects `c.*`, so it pins the column type and has to come down first. Postgres
-- refuses the ALTER otherwise ("cannot alter type of a column used by a view or rule").

drop view if exists due_cards;

alter table targets alter column angle type text using angle::text;
alter table cards   alter column angle type text using angle::text;

drop type if exists angle;

-- Rebuilt verbatim from 0001.
create view due_cards as
  select c.*, s.due, s.stability, s.difficulty, s.reps, s.lapses, s.state, s.last_review,
         s.skip_count, s.skipped_until, n.title as note_title, n.path as note_path
  from cards c
  join card_states s on s.card_id = c.id
  join notes n on n.id = c.note_id
  where c.status = 'active'
    and s.due <= now()
    and (s.skipped_until is null or s.skipped_until <= now());

-- Order matters only for readability; the cascades would handle it.
truncate table extraction_feedback, reviews, card_states, cards, targets, note_blocks, notes, scan_runs
  restart identity cascade;
