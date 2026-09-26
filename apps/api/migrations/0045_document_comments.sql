-- 0045_document_comments — a comment on a document (DOC "collaboration later", x132 slice).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Docs and knowledge" (the module is
-- marked "MVP-lite; collaboration later" — 0030_documents.sql defers "a document's versions/comments"
-- to a later slice with its own table), 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- A document (0030) can be read and versioned (0036) but not discussed. This is the smallest useful
-- unit of the deferred "collaboration": a **comment on a document** — a body of prose, an author,
-- and a time, against an existing document. It is deliberately not threaded, not editable and not
-- resolvable: edit/delete, resolve, and anchored ranges are a later slice (NEXT-SCOPES-13), each with
-- its own columns and state. So this table carries only what a comment *is* at rest.
--
-- ## Document-owned, and tenant-scoped like every sibling
--
-- `document_comments.document_id` is `NOT NULL`: a comment belongs to a document, the way a version
-- (0036) does. The comment is read and written by the document's relation (its project), resolved in
-- the service, so the two can never disagree — there is no `project_id` column to drift. The
-- composite foreign key `fk_document_comments_document_tenant` binds `(organization_id, document_id)`
-- to `documents`, so a comment can only ever name a document of its own tenant — a cross-tenant
-- document id does not exist as a pair even when both ids exist individually.
--
-- ## The author is a membership, not a bare user
--
-- `author_membership_id` names the membership row the comment was written under, bound by the
-- composite key `fk_document_comments_author_tenant` to `(organization_id, id)` of `memberships`: an
-- author is always a member of the comment's own tenant, never a bare user id that might belong to
-- someone with no standing in this studio. `body` is `TEXT` and `NOT NULL` — prose a person types,
-- the choice `documents.body` (0030) and `document_versions.body` (0036) make.
--
-- ## Append-only and immutable
--
-- A captured comment is a record of what someone said at a moment. Editing or re-pointing it is out
-- of this slice (NEXT-SCOPES-13), so the `BEFORE UPDATE` trigger refuses every UPDATE outright, the
-- posture `document_versions` (0036) and `meeting_notes` (0033) take. ADR-0001 layers 3 and 4 are
-- application-side and a direct SQL session bypasses both; the trigger holds it at the engine.

CREATE TABLE document_comments (
  id                   CHAR(36)     NOT NULL,
  organization_id      CHAR(36)     NOT NULL,
  document_id          CHAR(36)     NOT NULL,
  -- The membership the comment was written under; see the note above.
  author_membership_id CHAR(36)     NOT NULL,
  -- The comment body. Prose a person types, so TEXT and NOT NULL like documents.body.
  body                 TEXT         NOT NULL,
  created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_document_comments_org_id (organization_id, id),
  -- The index a document's comments are listed by: this tenant's comments for this document, in
  -- id (≈ creation) order. Leads with `organization_id` per `07-DATA-MODEL` §9.
  KEY ix_document_comments_org_document (organization_id, document_id, id),
  CONSTRAINT fk_document_comments_document_tenant
    FOREIGN KEY (organization_id, document_id) REFERENCES documents (organization_id, id),
  CONSTRAINT fk_document_comments_author_tenant
    FOREIGN KEY (organization_id, author_membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A captured comment is append-only: the trigger refuses every UPDATE at the engine, the posture
-- document_versions (0036) and meeting_notes (0033) take. Edit/delete is a later slice.
DELIMITER $$

CREATE TRIGGER trg_document_comments_immutable
BEFORE UPDATE ON document_comments FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'document_comments rows are immutable';
END$$

DELIMITER ;
