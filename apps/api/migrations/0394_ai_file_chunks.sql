-- 0394_ai_file_chunks — passages of a workspace's file texts, with their embedding, for permission-aware retrieval (plan 62, 62-24).
--
-- ## What this migration is for
--
-- Plan 62 §4.5 and §9 62-24: "Chunks, embeddings, vector store (VECTOR exact scan / BLOB
-- fallback), hybrid rank, filter-before-rank, re-check, dirty and purge hooks." The knowledge
-- index job (`copilot/knowledge/knowledge-index-job.ts`) cuts each ready `ai_file_texts` row into
-- passages of about 500 to 800 tokens, one set per live file asset that holds the text, and stores
-- them here with the asset's project and audience, so retrieval filters by workspace, the
-- member's projects and audience BEFORE it ranks (no vector index, so no "filter after search"
-- leak and no too-few-results problem). Every hit is re-checked through the file's own read rule
-- on fetch.
--
-- - `ai_file_chunks` (TENANT): one passage of one file asset. `body` is the passage text;
--   `embedding` its `VECTOR(512)` (cosine, exact scan inside the workspace; NULL while no
--   embedding provider is configured: keyword retrieval only); `embedding_model` names the model.
--   `content_hash` + `chunk_no` let a second file with the same bytes reuse the embeddings
--   (paid once). Deleting or purging a file deletes its passages in the same transaction.
--
-- The VECTOR type and VEC_DISTANCE_COSINE were proven on MariaDB 11.8.9 with the DML-only account
-- and bound parameters (PLAN-62-P0-RESULTS.md, 2026-11-19). Before this ships, the live server's
-- `SELECT VERSION()` must be checked (P0 open item): if it refuses the type, this column becomes a
-- BLOB of float32 and the Node store (`node-cosine-store.ts`) ranks.
--
-- No data is written here.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- One DDL statement, one new table. ENUM with literal values, literal defaults, no CHECK, no
-- generated column, no functional or partial index, no trigger, no foreign key (the 0257
-- convention). FULLTEXT on one TEXT column (InnoDB, as `search_index` 0054). No vector index on
-- purpose (exact scan). Additive only: old code ignores the table (DA-6).

CREATE TABLE ai_file_chunks (
  id               CHAR(36)          NOT NULL,
  organization_id  CHAR(36)          NOT NULL,
  project_id       CHAR(36)          NOT NULL,
  file_asset_id    CHAR(36)          NOT NULL,
  content_hash     VARCHAR(128)      NOT NULL,
  chunk_no         SMALLINT UNSIGNED NOT NULL,
  page_no          SMALLINT UNSIGNED NULL,
  audience         ENUM('internal', 'client_visible', 'client_action_required') NOT NULL DEFAULT 'internal',
  body             TEXT              NOT NULL,
  embedding        VECTOR(512)       NULL,
  embedding_model  VARCHAR(48)       NULL,
  created_at       DATETIME(3)       NOT NULL,
  updated_at       DATETIME(3)       NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_file_chunks_org_id (organization_id, id),
  UNIQUE KEY uq_ai_file_chunks_asset_no (organization_id, file_asset_id, chunk_no),
  KEY ix_ai_file_chunks_scope (organization_id, project_id),
  KEY ix_ai_file_chunks_hash (organization_id, content_hash, chunk_no),
  FULLTEXT KEY ft_ai_file_chunks_body (body)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
