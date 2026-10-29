-- 0246_platform_export_jobs — CSV exports of the activity logs, made in the background.
--
-- ## What this migration is for
--
-- Platform admin v2, Activity & access (SPEC §4 C6, §5.5, §6 0246). An operator asks for a CSV of
-- the current filter (actions, sign-ins, sessions, platform admin actions, organizations or
-- people); the request is a row here with the scope and the filter as JSON text. The worker
-- (`apps/worker/src/jobs/export-jobs.ts`, `--run-exports` and its loop) claims queued rows, writes
-- the CSV to the object store's private zone, and stamps `row_count`, `object_key`, `finished_at`
-- and `expires_at` (24 hours later) — or `error`. A file past `expires_at` is removed by the worker
-- and the row turns `expired`. "Delete" from the screen sets `status = 'deleted'`: the app user
-- never holds DELETE on this table.
--
-- Statuses (VARCHAR, closed list in TypeScript): queued, running, ready, failed, expired, deleted.
--
-- ## Global table (NON_TENANT_TABLES)
--
-- The jobs describe the operators' own work across every organization; an `actions` export may
-- name one organization in its filter but the row belongs to no tenant.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, literal defaults or CURRENT_TIMESTAMP(3), TEXT for the JSON filter, no generated
-- columns, no CHECK, utf8mb4_unicode_ci.

CREATE TABLE platform_export_jobs (
  id           CHAR(36)     NOT NULL,
  requested_by CHAR(36)     NOT NULL,
  scope        VARCHAR(32)  NOT NULL,
  filter_json  TEXT         NOT NULL,
  status       VARCHAR(16)  NOT NULL DEFAULT 'queued',
  row_count    INT          NULL,
  object_key   VARCHAR(512) NULL,
  error        VARCHAR(500) NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at  DATETIME(3)  NULL,
  expires_at   DATETIME(3)  NULL,
  PRIMARY KEY (id),
  KEY ix_platform_export_jobs_status (status, created_at),
  KEY ix_platform_export_jobs_requested (requested_by, created_at),
  CONSTRAINT fk_platform_export_jobs_user FOREIGN KEY (requested_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
