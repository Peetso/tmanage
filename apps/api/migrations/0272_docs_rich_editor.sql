-- 0272_docs_rich_editor — R5 slice 2 (PETER-REQUESTS-2026-10-31 R5, R5-SPEC §3): documents become
-- a rich editor.
--
-- 1. `documents.body` and `document_versions.body` become MEDIUMTEXT: a sanitised HTML body
--    (tables, embeds, callouts) is heavier than the Markdown it replaces, and the API now accepts
--    up to 1_000_000 characters (TEXT stops at 65_535 bytes).
-- 2. `body_format` on both says how to read `body`: 'markdown' (every existing row, the default)
--    or 'html' (sanitised by the API on save against the R5-SPEC §3 allowlist).
-- 3. `document_comments` gains the anchor of a comment on selected text (`anchor_id` is the
--    `mark[data-comment]` id in the body, `anchor_quote` the text that was selected) and the
--    resolve state (`resolved_at`, `resolved_by_user_id`; NULL = open). The index serves "the
--    threads on this anchor of this document" within one tenant.
--
-- Triggers: `trg_document_comments_immutable` (0245) pins only id, organization_id, document_id,
-- author_membership_id, body and created_at, so the four new columns may change without touching
-- it — a resolve is an UPDATE of `resolved_at`/`resolved_by_user_id` only. `trg_documents_immutable`
-- (0030) pins identity columns only, so `body_format` may follow each save. `document_versions`
-- stays fully immutable (0036): `body_format` is written once, on INSERT. An ALTER fires no trigger.
--
-- Grants: `tmanage_app` already holds UPDATE on `document_comments` (0245 soft delete) and
-- INSERT/UPDATE on `documents`, INSERT on `document_versions`; columns ride table-level grants.
--
-- MariaDB 11.8 / MySQL 8 safe: plain MODIFY/ADD COLUMN, literal ENUM default, no generated column,
-- no CHECK, no expression default. Both tables are rewritten once (small today).

ALTER TABLE documents
  MODIFY body MEDIUMTEXT NOT NULL,
  ADD COLUMN body_format ENUM('markdown', 'html') NOT NULL DEFAULT 'markdown';

ALTER TABLE document_versions
  MODIFY body MEDIUMTEXT NOT NULL,
  ADD COLUMN body_format ENUM('markdown', 'html') NOT NULL DEFAULT 'markdown';

ALTER TABLE document_comments
  ADD COLUMN anchor_id CHAR(36) NULL,
  ADD COLUMN anchor_quote VARCHAR(500) NULL,
  ADD COLUMN resolved_at DATETIME(3) NULL,
  ADD COLUMN resolved_by_user_id CHAR(36) NULL,
  ADD INDEX ix_document_comments_org_doc_anchor (organization_id, document_id, anchor_id);
