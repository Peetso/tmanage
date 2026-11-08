-- 0331_quote_converted_project — an accepted quote remembers the project it became (52-08).
--
-- ## What this migration is for
--
-- "Convert to project" on an accepted quote creates a project whose work items are the quote's
-- lines, and links the quote to it. Two nullable columns on `quotes`:
--
-- - `converted_project_id` — the project the quote became. Written once, in the same transaction
--   that creates the project, under a locking read of the quote; a second convert finds it set and
--   opens that project instead of creating another (idempotent).
-- - `converted_at` — when that happened.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Two plain nullable columns, no generated columns, no CHECK, no foreign keys (the 0257
-- convention). Additive only; existing rows read NULL (never converted). The table-level grants
-- of 0259 (scripts/db/users.sql) already cover them.

ALTER TABLE quotes
  ADD COLUMN converted_project_id CHAR(36)    NULL AFTER decided_at,
  ADD COLUMN converted_at         DATETIME(3) NULL AFTER converted_project_id;
