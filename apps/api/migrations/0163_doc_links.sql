-- 0163_doc_links — author-created links between documents, with reader backlinks (x296, Docs module).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Docs knowledge graph", 22-SCREEN-
-- INVENTORY DOC document detail, 23-ERD-AND-STATE-MACHINES §docs, 07-DATA-MODEL §9 (every composite
-- index begins with organization_id), 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC §5-6 (scoped writes,
-- composite (organization_id, id) foreign keys), ADR-0001 (MySQL has no row-level security; layers
-- 3-5 replace it).
--
-- ## What this migration is for
--
-- 0030_documents shipped the document record; 0114_doc_bookmarks a member's private favorites. This
-- slice adds the wiki-style relation the doc detail needs: an author links one document to another,
-- and a reader sees a read-only "linked from" (backlinks) list. One `doc_links` row is the fact
-- "source_doc links to target_doc, authored by created_by". An author links only documents they can
-- act on / read (the service resolves both ends tenant-scoped and relation-checks BEFORE the write),
-- and both the outgoing and the incoming lists a reader sees are re-projected to documents they can
-- still read, so a link never leaks the existence or title of a document the caller may not see.
--
-- ## A link is created and removed, never edited
--
-- A link belongs to exactly one tenant and names two of its documents. The only writes are INSERT
-- (link) and DELETE (unlink): there is no UPDATE path in the repository and no UPDATE grant in
-- scripts/db/users.sql, so the withheld privilege is the control (the doc_bookmarks / work_item_links
-- posture). `uq_doc_links_edge` makes a duplicate link a collision at the engine; the service treats
-- that collision as success, so a repeated create is idempotent rather than a second row. A
-- `BEFORE UPDATE` trigger refuses UPDATE wholesale as defence in depth, and a `BEFORE INSERT` trigger
-- refuses a self-link (source = target) — which the service also refuses first with a 400.
--
-- ## Tenant-scoped, and a link can never reference another tenant's document
--
-- Two composite foreign keys bind the row within one tenant: `(organization_id, source_doc_id)` and
-- `(organization_id, target_doc_id)` each to `documents (organization_id, id)`. A cross-tenant source
-- or target id does not exist as a pair even when both ids exist individually — the engine half of the
-- resolve-before-authorize trap the service enforces (a cross-tenant end is a 404, never a leak, never
-- a foreign-key 500). `created_by_user_id` binds to `users (id)`.

CREATE TABLE doc_links (
  id                CHAR(36)      NOT NULL,
  organization_id   CHAR(36)      NOT NULL,
  -- The document the link is authored on — the "source" of the relation. The composite FK below binds
  -- it to the tenant.
  source_doc_id     CHAR(36)      NOT NULL,
  -- The document it points at — the "target". Bound to the tenant by its own composite FK.
  target_doc_id     CHAR(36)      NOT NULL,
  -- The user who authored the link. Retained for provenance; the wire projection never echoes it.
  created_by_user_id CHAR(36)     NOT NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_doc_links_org_id (organization_id, id),
  -- Idempotency guard: the same directed pair linked twice collides here rather than creating a second
  -- row. Leads with organization_id per 07-DATA-MODEL §9.
  UNIQUE KEY uq_doc_links_edge (organization_id, source_doc_id, target_doc_id),
  -- 07-DATA-MODEL §9: the outgoing read — a document's links, newest first, id breaking ties.
  KEY ix_doc_links_source (organization_id, source_doc_id, created_at, id),
  -- The incoming read (backlinks): links pointing at one document, newest first.
  KEY ix_doc_links_target (organization_id, target_doc_id, created_at, id),
  CONSTRAINT fk_doc_links_source_tenant
    FOREIGN KEY (organization_id, source_doc_id) REFERENCES documents (organization_id, id),
  CONSTRAINT fk_doc_links_target_tenant
    FOREIGN KEY (organization_id, target_doc_id) REFERENCES documents (organization_id, id),
  CONSTRAINT fk_doc_links_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

-- A document cannot link to itself. Refused at the engine, and by the service first with a 400.
CREATE TRIGGER trg_doc_links_no_self
BEFORE INSERT ON doc_links FOR EACH ROW
BEGIN
  IF NEW.source_doc_id = NEW.target_doc_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'a document cannot link to itself';
  END IF;
END$$

-- A link is a fact with no editable field: correcting one is delete-and-add. UPDATE is refused
-- wholesale as defence in depth beside the withheld UPDATE grant.
CREATE TRIGGER trg_doc_links_no_update
BEFORE UPDATE ON doc_links FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'doc_links rows are immutable; delete and re-create instead';
END$$

DELIMITER ;
