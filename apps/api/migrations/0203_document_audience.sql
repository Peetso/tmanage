-- 0203_document_audience — who a document is shown to (DOC-01 AUDIENCE column, DOC-02 Publish).
--
-- `audience` is 'internal' (default: every existing document stays internal-only) or 'client'
-- (published to the project's client people). `published_at` / `published_by_user_id` stamp the
-- publish and are NULL while internal. The index serves the tenant-wide "Recent" list
-- (GET /v1/organizations/:orgSlug/recent-documents, ordered by updated_at DESC) and, like every
-- composite index here, begins with organization_id. MariaDB 11.8 / MySQL 8 safe: plain ADD COLUMN /
-- ADD INDEX, no generated columns, no CHECK on a non-deterministic expression.
ALTER TABLE documents
  ADD COLUMN audience ENUM('internal', 'client') NOT NULL DEFAULT 'internal' AFTER body,
  ADD COLUMN published_at DATETIME(3) NULL AFTER audience,
  ADD COLUMN published_by_user_id CHAR(36) NULL AFTER published_at,
  ADD INDEX ix_documents_org_updated (organization_id, updated_at, id);
