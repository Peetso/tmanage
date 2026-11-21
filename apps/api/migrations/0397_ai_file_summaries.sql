-- 0397_ai_file_summaries — the cached AI summary of a workspace file, once per (content hash, audience) (plan 62, 62-25).
--
-- ## What this migration is for
--
-- Plan 62 §4.5 ("file summary cached per content hash and audience; never shared across
-- workspaces") and §9 62-25 ("second ask of the same file is cheaper"). The first question about a
-- file sends its text to the model, which also records a neutral summary of it through a
-- server-side chat tool (`record_file_summary`); the next question about the same bytes gets the
-- summary and a few passages instead of the whole text, at the Low tier.
--
-- - `ai_file_summaries` (TENANT): `content_hash` is the file version's content hash (the key of
--   `ai_file_texts`); `audience` is the file's audience when the summary was written, so a
--   client-visible copy of the same bytes never reads an internal summary or the reverse. The
--   summary is model-written text from the file and is handled like the file's own text: read only
--   through the file's own read rule (`GET …/knowledge/files/:fileAssetId`), deleted with the text
--   row by the text job's orphan sweep, and by the company erasure.
--
-- No data is written here.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- One DDL statement, one new table. ENUM with literal values, literal defaults, no CHECK, no
-- generated column, no functional or partial index, no trigger, no foreign key (the 0257
-- convention). Additive only: old code ignores the table (DA-6).

CREATE TABLE ai_file_summaries (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  content_hash    VARCHAR(128) NOT NULL,
  audience        ENUM('internal', 'client_visible', 'client_action_required') NOT NULL,
  summary         TEXT         NOT NULL,
  model           VARCHAR(64)  NOT NULL,
  created_at      DATETIME(3)  NOT NULL,
  updated_at      DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_file_summaries_org_id (organization_id, id),
  UNIQUE KEY uq_ai_file_summaries_key (organization_id, content_hash, audience)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
