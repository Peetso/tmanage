-- 0393_ai_file_texts — the text of a workspace's files, extracted once per content hash for the AI knowledge layer (plan 62, 62-23).
--
-- ## What this migration is for
--
-- Plan 62 §4.5 and §9 62-23: "Text extraction in the worker with caps, content-hash cache,
-- `ai_file_texts`." The in-process text job (`files/file-text-job.ts`) reads each promoted,
-- scan-clean file version of a type it can read, at most once per distinct content hash in the
-- workspace, and stores the plain text here for 62-24 (chunks and embeddings). Nothing leaves the
-- server in this slice; no model is called.
--
-- - `ai_file_texts` (TENANT): one row per (workspace, content hash). `status`: `pending` while a
--   pass holds it (`claimed_at`), then `ready` (the text in `body`), `unsupported` (a type or size
--   it does not read, `reason_code`, no retry) or `failed` (the bytes did not decode, a timeout, or
--   the last attempt; `reason_code`). `truncated` is 1 when a cap (pages, characters) cut the text.
--   The text is never shared across workspaces: the same bytes in two workspaces are two rows.
--   A row whose hash no live version in the workspace holds any more is deleted by the job.
--
-- No data is written here.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- One DDL statement, one new table. ENUM with literal values, literal defaults, no CHECK, no
-- generated column, no functional or partial index, no trigger, no foreign key (the 0257
-- convention). Additive only: old code ignores the table (DA-6).

CREATE TABLE ai_file_texts (
  id              CHAR(36)          NOT NULL,
  organization_id CHAR(36)          NOT NULL,
  content_hash    VARCHAR(128)      NOT NULL,
  mime_type       VARCHAR(150)      NOT NULL,
  status          ENUM('pending', 'ready', 'unsupported', 'failed') NOT NULL,
  reason_code     VARCHAR(48)       NULL,
  extractor       VARCHAR(32)       NULL,
  body            MEDIUMTEXT        NULL,
  char_count      INT UNSIGNED      NOT NULL DEFAULT 0,
  page_count      INT UNSIGNED      NULL,
  truncated       TINYINT(1)        NOT NULL DEFAULT 0,
  attempts        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  claimed_at      DATETIME(3)       NULL,
  created_at      DATETIME(3)       NOT NULL,
  updated_at      DATETIME(3)       NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_file_texts_org_id (organization_id, id),
  UNIQUE KEY uq_ai_file_texts_org_hash (organization_id, content_hash),
  KEY ix_ai_file_texts_status (status, claimed_at, organization_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
