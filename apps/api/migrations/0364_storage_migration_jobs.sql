-- 0364_storage_migration_jobs — "Move to Drive" (57-13b, plan 57 §19.3).
--
-- ## What this migration is for
--
-- One row per request by a workspace owner or admin to move the files TManage still holds on its
-- own storage into the company's connected Google Drive or OneDrive. The API's in-process move
-- job (`storage-root/storage-move-job.ts`) works through the company's promoted, clean, local
-- versions in id order, a few at a time:
--
-- 1. read the local bytes and check them against `file_versions.content_hash`;
-- 2. upload them into the connection's own TManage folder, read the copy back and compare
--    SHA-256 (a mismatch removes the copy and leaves the file local);
-- 3. in one transaction: flip the version's `storage_backend`, `provider_file_id` and
--    `storage_connection_id` (only while it is still `local`), give the bytes back on the
--    `storage.bytes` counter with its ledger row, advance this row's counts and `cursor_version_id`,
--    and name the local object in `pending_object_key`;
-- 4. only then delete the local copy, and clear `pending_object_key`.
--
-- A crash between 3 and 4 leaves `pending_object_key` set, and the next pass deletes that object
-- (idempotent) before anything else, so no local copy is left behind as an orphan. A revoked grant
-- or an unreachable provider stops the job (`stopped`, `error`); nothing is deleted then.
--
-- - `kind`: `transient_to_provider` (the only kind; 51-17's re-home may add another).
-- - `backend`: `google_drive` | `onedrive`; `storage_connection_id`: the connection the job was
--   started on. The job stops if the company's live connection is no longer that one.
-- - `status`: `queued` -> `running` -> `done` | `stopped`.
-- - `active_organization_id`: the organization id while the job is queued or running, NULL once it
--   is finished. Its unique key allows one live job per company (MariaDB has no partial index).
-- - `claimed_at`: a pass holds the row; a claim older than the stale window is taken over.
--
-- TENANT (`organization_id`). The API creates and updates rows; no DELETE at runtime (the company
-- erasure empties it with every other tenant table).
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATETIME(3), no generated columns, no CHECK, no functional or partial indexes,
-- utf8mb4_unicode_ci. Additive only: one new table.

CREATE TABLE storage_migration_jobs (
  id                     CHAR(36)         NOT NULL,
  organization_id        CHAR(36)         NOT NULL,
  active_organization_id CHAR(36)         NULL,
  kind                   VARCHAR(32)      NOT NULL,
  backend                VARCHAR(16)      NOT NULL,
  storage_connection_id  CHAR(36)         NOT NULL,
  status                 VARCHAR(16)      NOT NULL,
  requested_by_user_id   CHAR(36)         NOT NULL,
  total                  INT UNSIGNED     NOT NULL DEFAULT 0,
  moved                  INT UNSIGNED     NOT NULL DEFAULT 0,
  failed                 INT UNSIGNED     NOT NULL DEFAULT 0,
  skipped                INT UNSIGNED     NOT NULL DEFAULT 0,
  moved_bytes            BIGINT UNSIGNED  NOT NULL DEFAULT 0,
  cursor_version_id      CHAR(36)         NULL,
  pending_object_key     VARCHAR(512)     NULL,
  error                  VARCHAR(64)      NULL,
  claimed_at             DATETIME(3)      NULL,
  started_at             DATETIME(3)      NULL,
  finished_at            DATETIME(3)      NULL,
  created_at             DATETIME(3)      NOT NULL,
  updated_at             DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_storage_migration_jobs_org_id (organization_id, id),
  UNIQUE KEY uq_storage_migration_jobs_active (active_organization_id),
  KEY ix_storage_migration_jobs_org_created (organization_id, created_at),
  KEY ix_storage_migration_jobs_status (status, claimed_at),
  CONSTRAINT fk_storage_migration_jobs_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
