-- 0003 — allow 'drop' in the review log.
--
-- Cards now enter the deck directly and are vetted on their first review, so "I don't want this
-- card" is a review outcome rather than a separate approval step. It is recorded like any other
-- action so the log stays a complete account of every interaction with a card.

alter table reviews drop constraint if exists reviews_action_check;
alter table reviews add constraint reviews_action_check
  check (action in ('grade', 'skip', 'flag_bad', 'drop'));
