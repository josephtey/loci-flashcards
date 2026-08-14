-- 0004 — cards that belong to no note.
--
-- Everything so far has come from the vault, so `note_id` was mandatory and provenance was
-- guaranteed. But a card you simply want to remember — something from a conversation, a paper you
-- have not written up, a fact you keep forgetting — has no source note, and inventing a fake one
-- to satisfy a foreign key would put a lie in the provenance chain that the Cards view reads back.
--
-- So the column becomes nullable, and `due_cards` left-joins instead. A null title is the honest
-- representation of "you wrote this yourself".

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

-- 0003 may not have been run; fold it in so one paste catches both.
alter table reviews drop constraint if exists reviews_action_check;
alter table reviews add constraint reviews_action_check
  check (action in ('grade', 'skip', 'flag_bad', 'drop'));
