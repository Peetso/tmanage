-- 0253_platform_backup_runs — one row per backup, off-site copy and restore drill (51-09, 56-12, 56-29).
--
-- ## What this migration is for
--
-- `scripts/ops/backup.mjs` (hPanel cron, daily 03:00) and `scripts/ops/restore-drill.mjs` (monthly)
-- record every run here, so `GET /healthz/deep` can say whether backups are fresh (`backups: ok` /
-- `stale`) and the Platform → Backups card (56-12) can show the last dump, the last off-site copy
-- and the last drill. The scripts write through the operator's migration credential with the
-- `mysql` client; the runtime user only reads.
--
-- ## Columns
--
-- - `kind` `scheduled | manual | drill`; `frequency_kind` `daily | sixhourly | manual | drill`
--   (56-29: the 6-hourly job starts with 52-09 client invoices).
-- - `status` `ok | failed`; `error` is the script's one-line message, never a credential.
-- - `manifest_sha` is the SHA-256 of the backup's `manifest.json`, which itself holds the SHA-256
--   of every file (tamper evidence).
-- - `offsite_status` `not_requested | skipped | uploaded | failed`; `skipped` = no
--   `BACKUP_AGE_RECIPIENT` / Drive credentials (keyless host-only mode). `offsite_location` is
--   `gdrive:<folder id>/<stamp>` — a location, not a link or a token.
--
-- ## Global (NON_TENANT_TABLES)
--
-- Backups belong to the platform, never to one organization; no tenant data is stored here.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, closed lists checked in the scripts, no generated columns, no CHECK on JSON, no
-- functional indexes, utf8mb4_unicode_ci. Additive only.

CREATE TABLE platform_backup_runs (
  id               CHAR(36)      NOT NULL,
  kind             VARCHAR(16)   NOT NULL,
  frequency_kind   VARCHAR(16)   NOT NULL,
  stamp            VARCHAR(20)   NULL,
  started_at       DATETIME(3)   NOT NULL,
  finished_at      DATETIME(3)   NULL,
  status           VARCHAR(16)   NOT NULL,
  db_bytes         BIGINT        NULL,
  uploads_bytes    BIGINT        NULL,
  manifest_sha     CHAR(64)      NULL,
  git_sha          VARCHAR(64)   NULL,
  offsite_status   VARCHAR(16)   NOT NULL DEFAULT 'not_requested',
  offsite_location VARCHAR(255)  NULL,
  offsite_at       DATETIME(3)   NULL,
  error            VARCHAR(500)  NULL,
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_platform_backup_runs_kind_finished (kind, finished_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
