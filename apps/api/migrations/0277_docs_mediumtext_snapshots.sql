-- 0277_docs_mediumtext_snapshots — R5 fix-forward (gate2, 2026-11-01).
--
-- 0272 made `documents.body` and `document_versions.body` MEDIUMTEXT so a sanitised HTML body
-- above 64 KB can be saved. Two copies of that body were left at TEXT (65_535 bytes) and would
-- refuse the same save:
--
-- 1. `doc_revisions.body_snapshot` (0113): the captured body of a revision.
-- 2. `search_index.body_text` (0054): the indexed text of a document (and other targets).
--
-- Both become MEDIUMTEXT NOT NULL, matching the body they copy. The FULLTEXT key on
-- `search_index (title, body_text)` accepts MEDIUMTEXT, and InnoDB rebuilds it with the table.
--
-- Triggers: `trg_doc_revisions_immutable` refuses UPDATE only; an ALTER fires no trigger. No grant
-- changes (columns ride table-level grants).
--
-- MariaDB 11.8 / MySQL 8 safe: plain MODIFY of a column type, no default, no generated column.

ALTER TABLE doc_revisions
  MODIFY body_snapshot MEDIUMTEXT NOT NULL;

ALTER TABLE search_index
  MODIFY body_text MEDIUMTEXT NOT NULL;
