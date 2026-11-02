-- 0316_import_undo — 54-24 import undo for every kind, R23-e.
--
-- Governing source: 54-24 ("undo = soft-delete every `created` target id … reversible until the
-- 30-day purge; 7-day window for the one-click"; "audit `import.run / import.undo` with counts").
--
-- - `import_rows.entity_type` — the kind of `created_entity_id` (`project` | `work_item` |
--   `document` | `phase` | `label`), written at insert by the commit. NULL for a failed row and
--   for every row written before this migration (such a job is not undoable: 409
--   `import_undo_unsupported`). `import_rows` stays INSERT-only for the API.
-- - `import_jobs.undone_at / undone_by_user_id / undone_count` — the one-click undo's stamp
--   (`POST …/imports/:jobId/undo`). NULL until undone; a job is undone at most once.
--
-- No new table, so no tenant-guard row. MariaDB-safe (Hostinger): plain nullable columns, no
-- generated column, no CHECK, no IF NOT EXISTS, DATETIME(3). Additive only.

ALTER TABLE import_rows ADD COLUMN entity_type VARCHAR(16) NULL;

ALTER TABLE import_jobs
  ADD COLUMN undone_at DATETIME(3) NULL,
  ADD COLUMN undone_by_user_id CHAR(36) NULL,
  ADD COLUMN undone_count INT UNSIGNED NULL;
