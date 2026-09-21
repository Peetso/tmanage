-- 0036_document_versions — the append-only version history behind a document (DOC-02/DOC-03, x112).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Docs and knowledge"
-- ("Documents, briefs, wiki … collaboration later"), 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §Docs
-- DOC-02 (editor) + DOC-03 (version history / compare / restore), 23-ERD-AND-STATE-MACHINES §2
-- (project-owned records reached through their parent), 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## Migration number
--
-- The highest migration on this slice's base (pass-16 master 10aab0c) is 0032. 0033 (x105), 0034
-- (x107) and 0035 (x110) are reserved on other branches in flight, so this is named 0036 to sit
-- above them and avoid a collision; the integrator renumbers if the merge order differs.
--
-- ## What this migration is for
--
-- 0030_documents shipped the document *record* — a title and a body — and said plainly there was
-- "no versioning/history" and that it was a later slice. This is that slice: a document now carries
-- an ordered, immutable trail of the bodies it has held. Each save appends one `document_versions`
-- row (the snapshot) and bumps the parent `documents.body` to match, in one transaction. Editing a
-- document is therefore forward-append, never an in-place rewrite that loses what was there before.
--
-- ## Append-only, and a snapshot is never edited
--
-- There is no UPDATE path for `document_versions` in the repository, and the trigger below refuses
-- one at the engine — the reason every immutability trigger in this schema exists: ADR-0001 layers
-- 3 and 4 are application-side and a direct SQL session bypasses both. DOC-03's *restore* is not an
-- edit of history: it appends a NEW version whose body equals a prior snapshot, so the old bytes
-- and the ordering survive (the same shape `deliverable_versions` (0027) uses — a change is a new
-- row, never a mutation of an old one).
--
-- ## `version_no` is monotonic per document, and the pair is unique
--
-- `version_no` counts a document's saves from 1. The unique key on
-- `(organization_id, document_id, version_no)` is both the list index (newest-first is an ordered
-- walk of it) and the concurrency guard: two saves that race to the same next number collide on
-- the key rather than silently interleaving. It is also the index DOC-03's compare read uses to
-- fetch one snapshot by number.
--
-- ## Tenant-scoped, and a version can never reference another tenant's document
--
-- The composite foreign key `fk_document_versions_document_tenant` binds
-- `(organization_id, document_id)` to `documents (organization_id, id)`, so a version can only ever
-- name a document of its own tenant — a cross-tenant document id does not exist as a pair even when
-- both ids exist individually (the guarantee 0030's own project FK gives, one level down).

CREATE TABLE document_versions (
  id                 CHAR(36)        NOT NULL,
  organization_id    CHAR(36)        NOT NULL,
  -- The document this is a version of. NOT NULL; the composite FK below binds it to the tenant.
  document_id        CHAR(36)        NOT NULL,
  -- A document's saves numbered from 1, monotonic per document. See the note above.
  version_no         INT UNSIGNED    NOT NULL,
  -- The body as it stood at this save. Plain text like `documents.body` (0030) — a document is
  -- prose a person types — so TEXT and NOT NULL.
  body               TEXT            NOT NULL,
  -- The person who saved this version (a restore records the person who restored). The service
  -- passes `context.userId`.
  edited_by_user_id  CHAR(36)        NOT NULL,
  created_at         DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_document_versions_org_id (organization_id, id),
  -- Monotonic per document, and the concurrency guard for a racing save. Leads with
  -- `organization_id` per 07-DATA-MODEL §9; a newest-first list is an ordered walk of this key.
  UNIQUE KEY uq_document_versions_org_doc_version
    (organization_id, document_id, version_no),
  CONSTRAINT fk_document_versions_document_tenant
    FOREIGN KEY (organization_id, document_id) REFERENCES documents (organization_id, id),
  CONSTRAINT fk_document_versions_edited_by
    FOREIGN KEY (edited_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

-- A document version is immutable: it is the record of what the document said at a moment, and
-- DOC-03's restore is an INSERT of a new row, never an UPDATE of this one. The trigger refuses any
-- change outright — the same posture `client_projections` (0031) takes — so history cannot be
-- rewritten even by a direct SQL session.
CREATE TRIGGER trg_document_versions_immutable
BEFORE UPDATE ON document_versions FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'document_versions rows are immutable: history is append-only (restore adds a new version)';
END$$

DELIMITER ;
