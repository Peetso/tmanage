-- 0338_document_archive — a doc can be archived (FIX3 item 6, live check a6f66e47 D4).
--
-- Archive takes a doc out of the Docs lists without removing it: the doc still opens from a link,
-- and anyone who may edit it can bring it back. Delete is the existing soft delete (0245:
-- `deleted_at`, `deleted_by_user_id`, `deleted_reason`, `purge_after`), set from the doc itself
-- now and not only from the platform console.
--
-- NULL means the doc is not archived (every doc before this migration). `archived_by_user_id` is a
-- plain CHAR(36) with no foreign key, like `title_updated_by_user_id` (0227): it is written from the
-- acting context, never from a request body. `trg_documents_immutable` (0030) guards other columns
-- only. MariaDB-safe: plain ADD COLUMN, no CHECK, no generated column.

ALTER TABLE documents
  ADD COLUMN archived_at DATETIME(3) NULL,
  ADD COLUMN archived_by_user_id CHAR(36) NULL;
