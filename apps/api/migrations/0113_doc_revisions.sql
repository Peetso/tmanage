-- 0113_doc_revisions — append-only revision history behind a document (DOC revision history, x241).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Docs and knowledge", 23-ERD-AND-
-- STATE-MACHINES §2 (project-owned records reached through their parent), 07-DATA-MODEL §9 (index
-- prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant
-- keys).
--
-- ## What this migration is for
--
-- 0030_documents shipped the document record — a title and a body. This slice gives it a snapshot
-- trail: each capture appends one `doc_revisions` row (the body as it stood, and who saved it) and
-- bumps the parent `documents.body` to match, in one transaction. Restoring is forward-append, never
-- an in-place rewrite that loses what was there before.
--
-- ## Append-only, and a snapshot is never edited
--
-- There is no UPDATE path for `doc_revisions` in the repository, and the trigger below refuses one
-- at the engine — the reason every immutability trigger in this schema exists: ADR-0001 layers 3
-- and 4 are application-side and a direct SQL session bypasses both. A restore is not an edit of
-- history: it appends a NEW revision whose body equals a prior snapshot, so the old bytes and the
-- ordering survive.
--
-- ## `rev_no` is monotonic per document, and the pair is unique
--
-- `rev_no` counts a document's captures from 1. The unique key on
-- `(organization_id, doc_id, rev_no)` is both the list index (newest-first is an ordered walk of
-- it) and the concurrency guard: two captures that race to the same next number collide on the key
-- rather than silently interleaving.
--
-- ## Tenant-scoped, and a revision can never reference another tenant's document
--
-- The composite foreign key `fk_doc_revisions_document_tenant` binds `(organization_id, doc_id)` to
-- `documents (organization_id, id)`, so a revision can only ever name a document of its own tenant —
-- a cross-tenant document id does not exist as a pair even when both ids exist individually.

CREATE TABLE doc_revisions (
  id                 CHAR(36)        NOT NULL,
  organization_id    CHAR(36)        NOT NULL,
  -- The document this is a revision of. NOT NULL; the composite FK below binds it to the tenant.
  doc_id             CHAR(36)        NOT NULL,
  -- A document's captures numbered from 1, monotonic per document. See the note above.
  rev_no             INT UNSIGNED    NOT NULL,
  -- The body as it stood at this capture. Plain text like `documents.body` (0030), so TEXT NOT NULL.
  body_snapshot      TEXT            NOT NULL,
  -- The person who saved this revision (a restore records the person who restored). The service
  -- passes `context.userId`.
  saved_by           CHAR(36)        NOT NULL,
  saved_at           DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_doc_revisions_org_id (organization_id, id),
  -- Monotonic per document, and the concurrency guard for a racing capture. Leads with
  -- `organization_id` per 07-DATA-MODEL §9; a newest-first list is an ordered walk of this key.
  UNIQUE KEY uq_doc_revisions_org_doc_rev
    (organization_id, doc_id, rev_no),
  CONSTRAINT fk_doc_revisions_document_tenant
    FOREIGN KEY (organization_id, doc_id) REFERENCES documents (organization_id, id),
  CONSTRAINT fk_doc_revisions_saved_by
    FOREIGN KEY (saved_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

-- A document revision is immutable: it is the record of what the document said at a moment, and a
-- restore is an INSERT of a new row, never an UPDATE of this one. The trigger refuses any change
-- outright, so history cannot be rewritten even by a direct SQL session.
CREATE TRIGGER trg_doc_revisions_immutable
BEFORE UPDATE ON doc_revisions FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'doc_revisions rows are immutable: history is append-only (restore adds a new revision)';
END$$

DELIMITER ;
