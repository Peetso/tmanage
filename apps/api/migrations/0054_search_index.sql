-- 0054_search_index — SRCH ranking (module 16, x148). NS-11 deferred full-text index + ranking.
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Search ("global search … ranked
-- results"); 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §Search; 07-DATA-MODEL §9 (index prefixes lead
-- with `organization_id`); 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys,
-- organization_id on every tenant-owned table).
--
-- ## Migration number
--
-- Reserved 0054 for this slice (pass 20). The highest migration on this branch's base is 0039;
-- 0040–0053 are reserved on sibling branches in flight, so this sits above them and the migrator
-- (ascending, gaps allowed) applies it cleanly. The integrator renumbers only if the merge order
-- differs.
--
-- ## What this migration is for
--
-- Global search (SRCH-01, x111) matched titles with a `LIKE '%…%'` scan over three live tables and
-- returned them in a fixed kind/title order — no relevance, no ranking (the audit's "Search
-- Partial"). This slice adds the ranking backbone: a tenant-scoped, denormalised **search index**
-- with a MySQL `FULLTEXT` index on `(title, body_text)`, so `MATCH … AGAINST` can rank hits by
-- relevance and break ties by recency. The service reads this table instead of scanning the source
-- tables; the naive `LIKE` scan is retired.
--
-- ## Why the index is denormalised (project_id + audience live here)
--
-- The security spine of search is unchanged: a hit is only returned if the caller may read it, and
-- `authorize()` needs the hit's `organization_id`, `project_id` and `audience` to judge that. A
-- minimal index of title/body alone would force a join back to the source rows to recover those, re-
-- introducing the per-kind logic the ranked single-statement query exists to remove. So the index
-- carries `project_id` and `audience` denormalised from the source row — the relation filter keeps
-- running per hit, exactly as before, over one ranked read.
--
-- ## What is indexed this slice
--
-- Work items and documents only (the plan's "wire minimally for work items + documents"). Meetings,
-- conversation/note bodies and an AI answer are deferred (NS-13), and so is the incremental reindex
-- job that keeps this table fresh on every source write. This slice seeds the index from the
-- current rows (the backfill below) so search returns results immediately; keeping it live on write
-- is the deferred reindex job's work. Work items have no body column, so their `body_text` is the
-- title (title-weighted match); documents carry their `body`.
--
-- ## Identity is immutable
--
-- `organization_id`, `target_kind` and `target_id` are what an index row *is* — the tenant and the
-- source row it mirrors. The `BEFORE UPDATE` trigger pins them at the engine (ADR-0001 layers 3/4
-- are application-side and a direct SQL session bypasses both), the reason every other identity
-- trigger in this schema exists. `title`, `body_text`, `audience` and `updated_at` stay editable so
-- a reindex can refresh a row in place (INSERT … ON DUPLICATE KEY UPDATE on the target key).

CREATE TABLE search_index (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The source row's project, denormalised so the relation filter authorises each hit without a
  -- join back to the source table.
  project_id      CHAR(36)     NOT NULL,
  -- Which source table the row mirrors: 'work_item' or 'document' this slice.
  target_kind     VARCHAR(32)  NOT NULL,
  -- The source row's id (work_items.id / documents.id). Not a foreign key: it is polymorphic across
  -- source tables, so no single FK can express it.
  target_id       CHAR(36)     NOT NULL,
  -- The searchable title, mirrored from the source row (both `VARCHAR(300)`).
  title           VARCHAR(300) NOT NULL,
  -- The searchable body. A document's `body`; a work item's title (no body column — title-only
  -- match until body sources land, NS-13).
  body_text       TEXT         NOT NULL,
  -- The source row's audience, denormalised so a hit is authorised against its own audience exactly
  -- as its direct read is. Documents are internal by construction.
  audience        ENUM('internal', 'client_visible', 'client_action_required') NOT NULL DEFAULT 'internal',
  -- The recency tiebreak for equally-relevant hits, mirrored from the source row.
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries (isolation corpus requires it).
  UNIQUE KEY uq_search_index_org_id (organization_id, id),
  -- One index row per source row, per tenant: the upsert (reindex) key.
  UNIQUE KEY uq_search_index_target (organization_id, target_kind, target_id),
  -- This tenant's index in recency order — the tiebreak read after relevance. Leads with
  -- `organization_id` per 07-DATA-MODEL §9.
  KEY ix_search_index_org_updated (organization_id, updated_at, id),
  -- The ranking index. MySQL InnoDB FULLTEXT over the two searchable columns; `MATCH(title,
  -- body_text) AGAINST (?)` uses it and yields the relevance score the service orders by.
  FULLTEXT KEY ft_search_index_title_body (title, body_text),
  CONSTRAINT fk_search_index_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the index from the current work items and documents so search ranks over real data the
-- moment this migration lands. `UUID()` gives each index row its own identity (the source id is
-- kept in `target_id`). Soft-deleted work items are excluded, matching the live search's filter.
INSERT INTO search_index
  (id, organization_id, project_id, target_kind, target_id, title, body_text, audience, updated_at)
SELECT UUID(), organization_id, project_id, 'work_item', id, title, title, audience, updated_at
FROM work_items
WHERE deleted_at IS NULL;

INSERT INTO search_index
  (id, organization_id, project_id, target_kind, target_id, title, body_text, audience, updated_at)
SELECT UUID(), organization_id, project_id, 'document', id, title, body, 'internal', updated_at
FROM documents;

-- Identity is immutable; the searchable fields and recency are not (a reindex refreshes them).
DELIMITER $$

CREATE TRIGGER trg_search_index_immutable
BEFORE UPDATE ON search_index FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'search_index.organization_id is immutable';
  END IF;
  IF NEW.target_kind <> OLD.target_kind THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'search_index.target_kind is immutable';
  END IF;
  IF NEW.target_id <> OLD.target_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'search_index.target_id is immutable';
  END IF;
END$$

DELIMITER ;
