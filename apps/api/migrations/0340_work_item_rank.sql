-- 0340_work_item_rank — the hand-made order of work on the Board and the List (FIX3 item C,
-- "make the tasks draggable").
--
-- A drag inside a Board column or a List reorders the work for everyone on the team, so the order
-- is stored on the item. `board_rank` is a sort key: the web places a dropped item between its two
-- new neighbours by giving it the midpoint of their keys, so one drag writes one row. NULL (every
-- item before this migration, and new items) sorts by its creation time; the web uses the same
-- millisecond scale for both, so a dragged item lands exactly where it was dropped.
--
-- MariaDB-safe: plain ADD COLUMN, DOUBLE, no CHECK, no generated column.

ALTER TABLE work_items
  ADD COLUMN board_rank DOUBLE NULL;
