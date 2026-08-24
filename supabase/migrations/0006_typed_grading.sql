-- 0006 — typed answers and what the auto-grader made of them.
--
-- Recall mode replaces the self-judgement with a typed answer that a local model grades. The
-- model's verdict is a *proposal*: it is shown, and Joseph accepts it or overrides it before
-- anything is written. Both numbers are kept.
--
-- Keeping both is the entire point. `grader_rating <> rating` is the disagreement set — every
-- card where the auto-grader was wrong, with the answer that fooled it sitting in the same row.
-- That is the only way to tell whether the rubric needs rewording, the model needs to be bigger,
-- or the card itself is ambiguous. Storing only the accepted grade would leave the grader
-- permanently unfalsifiable.
--
-- These live on `reviews` rather than a side table because `reviews` is already the append-only
-- account of every interaction with a card, and "you typed this and the machine said that" is
-- one such interaction. A join would only be a way of pretending it wasn't.

alter table reviews add column if not exists typed_answer  text;
alter table reviews add column if not exists grader_rating smallint
  check (grader_rating between 1 and 4);
alter table reviews add column if not exists grader_verdict text;
alter table reviews add column if not exists grader_missing text;
alter table reviews add column if not exists grader_model  text;
-- How long the model took. Recall mode is only viable if this stays in the low seconds, and the
-- honest way to know is to measure it on real cards rather than to assume.
alter table reviews add column if not exists grader_ms     integer;

-- The disagreements, which is what you actually read when calibrating. Partial, because the
-- overwhelming majority of rows are self-graded or agreed and would only pad the index.
create index if not exists reviews_grader_disagreed_idx
  on reviews (reviewed_at desc)
  where grader_rating is not null and grader_rating is distinct from rating;
