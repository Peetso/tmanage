-- 0139_doc_tags — document tags / labels (x269, Docs module).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Docs and knowledge" (durable
-- context, findability — the DOC-01 hub filter), 23-ERD-AND-STATE-MACHINES §2 (tenant-scoped,
-- parent-owned records), 07-DATA-MODEL §9 (composite indexes lead with organization_id),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC §6 (composite (organization_id, id) foreign keys),
-- ADR-0001 (MySQL has no row-level security; layers 3-5 replace it).
--
-- ## What this migration is for
--
-- 0030_documents shipped the document record; there was no way to hang an org-defined label on a
-- document and later list documents by that label. This is that taxonomy at its smallest useful
-- size — define a named tag once per studio, then tag / untag documents with it, mirroring
-- `work_item_labels` (0105) for the Docs module.
--
-- ## One table, two row kinds
--
-- `doc_tags` holds both halves in one table, distinguished by nullability:
--
--   * A **definition** row carries `name`, with `document_id` and `tag_id` NULL. It is the reusable
--     tag. `name` is unique per tenant (`uq_doc_tags_org_name`); the many NULL names on assignment
--     rows do not collide because a UNIQUE index treats NULLs as distinct.
--   * An **assignment** row carries `document_id` + `tag_id` (pointing at a definition row), with
--     `name` NULL. `(organization_id, document_id, tag_id)` is unique so tagging is idempotent — a
--     second identical assign is a no-op, not a duplicate.
--
-- ## Parent- and tenant-scoped
--
-- Everything belongs to one studio. `organization_id` scopes every row. Two composite foreign keys
-- make a cross-tenant reference a non-existent pair rather than a leak: `fk_doc_tags_document` binds
-- `(organization_id, document_id)` to `documents (organization_id, id)`, and the self-referential
-- `fk_doc_tags_tag` binds `(organization_id, tag_id)` to this table's own `(organization_id, id)`.
-- That is the engine half of the trap the service also enforces in code: a cross-tenant document or
-- tag id is a 404 with no write, never a row against another studio's document.
--
-- ## Identity is immutable
--
-- `organization_id` is what a row *is* — moving it to another studio is not an edit. The
-- `BEFORE UPDATE` trigger holds that at the engine, the way `work_item_labels` (0105) does; ADR-0001
-- layers 3 and 4 are application-side and a direct SQL session bypasses both.

CREATE TABLE doc_tags (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  -- Set on ASSIGNMENT rows (the tagged document); NULL on DEFINITION rows.
  document_id      CHAR(36)     NULL,
  -- Set on ASSIGNMENT rows (the definition row this points at); NULL on DEFINITION rows.
  tag_id           CHAR(36)     NULL,
  -- Set on DEFINITION rows (the tag's display name, unique per tenant); NULL on ASSIGNMENT rows.
  name             VARCHAR(120) NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries; also the target of the
  -- self-referential tag foreign key below.
  UNIQUE KEY uq_doc_tags_org_id (organization_id, id),
  -- A tag's name is unique per studio. Assignment rows carry a NULL name and a UNIQUE index treats
  -- NULLs as distinct, so they never collide here.
  UNIQUE KEY uq_doc_tags_org_name (organization_id, name),
  -- Tagging is idempotent: one (document, tag) pair once. Definition rows carry NULLs in both
  -- columns and so are exempt from this constraint.
  UNIQUE KEY uq_doc_tags_assignment (organization_id, document_id, tag_id),
  -- The index a document's chips are read by: this tenant's assignment rows for one document.
  KEY ix_doc_tags_document (organization_id, document_id, id),
  -- An assignment can only ever name a document of its own tenant.
  CONSTRAINT fk_doc_tags_document
    FOREIGN KEY (organization_id, document_id) REFERENCES documents (organization_id, id),
  -- An assignment can only ever name a tag definition of its own tenant.
  CONSTRAINT fk_doc_tags_tag
    FOREIGN KEY (organization_id, tag_id) REFERENCES doc_tags (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A tag row's tenant is immutable, for the reason `work_item_labels`' trigger gives: moving it to
-- another studio would change what it is, silently.
DELIMITER $$

CREATE TRIGGER trg_doc_tags_immutable
BEFORE UPDATE ON doc_tags FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'doc_tags.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
