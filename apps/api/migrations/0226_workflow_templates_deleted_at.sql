-- 0226_workflow_templates_deleted_at — "Delete rule" on the automation rule page (A14, Figma
-- fq11-automation-rule).
--
-- The rule page has a red "Delete rule". A rule has run history (`workflow_runs`), schedules
-- and conditions that point at it through composite foreign keys, so a hard DELETE would either
-- fail or take the history with it. Instead a deleted rule is stamped: `deleted_at` is NULL for a
-- live rule (every row before this migration) and the instant it was deleted otherwise. The
-- delete also turns the rule off, so the worker (which reads only enabled rules) never fires it
-- again, and every read path filters `deleted_at IS NULL`, so a deleted rule leaves the list and
-- its id answers 404.
--
-- Plain ADD COLUMN, nullable, no default, no CHECK and no generated column: the live host is
-- MariaDB, and this schema keeps to the syntax both engines read the same way. The identity
-- trigger (0063) does not look at this column, so the soft-delete UPDATE passes it.

ALTER TABLE workflow_templates
  ADD COLUMN deleted_at DATETIME(3) NULL AFTER created_at;
