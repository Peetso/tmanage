-- 0227_document_title_renamed_by — who last renamed a document (F2, rename in the editor).
--
-- The editor's rename is optimistic (B4): a stale `expectedUpdatedAt` is 409. When the reason is
-- that somebody else renamed the doc, the editor says who — "Salma Riad renamed this doc to …" —
-- and offers "Keep my name" or "Use …". The document row keeps only the id of the person whose
-- rename is the current title; the editor resolves the name against the member directory.
--
-- NULL means the title has not been renamed since creation (every document before this migration).
-- A plain CHAR(36) with no foreign key, like `published_by_user_id` (0203): the row is tenant-keyed
-- `(organization_id, id)` and the value is written from the acting context, never from the body.
-- `trg_documents_immutable` (0030) guards other columns only, so the rename may set this one.
-- MariaDB-safe: plain ADD COLUMN, no CHECK, no generated column.

ALTER TABLE documents
  ADD COLUMN title_updated_by_user_id CHAR(36) NULL AFTER updated_at;
