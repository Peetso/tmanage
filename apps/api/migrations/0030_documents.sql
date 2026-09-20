-- 0030_documents — the first durable docs-and-knowledge record (DOC-01, x91 slice 1).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Docs and knowledge" ("Documents,
-- briefs, wiki, templates, decision register, glossary … inline linked objects and a Context Lens",
-- marked "MVP-lite; collaboration later"), 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §8 (DOC-01 Docs
-- hub), 23-ERD-AND-STATE-MACHINES §2 (`PROJECT ||--o{ …` project-owned records), 07-DATA-MODEL §9
-- (index prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite
-- tenant keys).
--
-- ## What this migration is for
--
-- The `/docs` route is a stub and nothing in the schema can hold a document (audit "ten largest
-- remaining" #3). This is the smallest useful unit that changes that: a **project document** — a
-- title and a body — as a durable, tenant-scoped record. It is deliberately *not* the whole of the
-- doc-38 vision. There is no wiki tree, no templates, no decision register, no glossary, no
-- versioning/history and no Context Lens: doc 38 marks the module "MVP-lite; collaboration later",
-- and each of those is a later slice with its own tables and state. Adding a `template_id`, a
-- `parent_id` wiki edge or a `decision_id` link here, before any of those tables exist, would be a
-- foreign key with nothing to reference and a shape no reviewer agreed to — the same mistake
-- `0007_conversations.sql` refused with its absent `kind` column. So this table carries only what a
-- document *is* at rest.
--
-- ## Project channels only, and tenant-scoped like every sibling
--
-- `documents.project_id` is `NOT NULL`: a document belongs to a project, the way a conversation and
-- a meeting (0029) do. `doc.read` is relation-gated in the same way `work.read` is (project
-- membership), so a document with no project would have no relation for the evaluator to check. The
-- composite foreign key `fk_documents_project_tenant` binds `(organization_id, project_id)` to
-- `projects`, so a document can only ever name a project of its own tenant — a cross-tenant project
-- id does not exist as a pair even when both ids exist individually.
--
-- ## `body` is plain text this slice
--
-- A document body is prose a person types, so it is `TEXT` and `NOT NULL` — the same choice
-- `conversations.body` (0007) made for a message. Rich text is a second representation with its own
-- sanitisation question (see `0008_message_rich_text.sql`); this slice stores the plain text a
-- document *is*, and a `body_rich`/history/versioning pair is a later slice, not a column added
-- before the code that fills it exists.
--
-- ## Identity is immutable
--
-- `organization_id` and `project_id` are what a document is: re-pointing a document at another
-- project would move it, silently, into a room a different set of people can read. The
-- `BEFORE UPDATE` trigger holds that at the engine, the reason every other trigger in this schema
-- exists — ADR-0001 layers 3 and 4 are application-side and a direct SQL session bypasses both.
-- `title` and `body` are editable; identity is not.

CREATE TABLE documents (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- NOT NULL. A document belongs to a project; see the note above.
  project_id         CHAR(36)     NOT NULL,
  -- `client_requests.title` is VARCHAR(300); a document title is the same kind of short handle.
  title              VARCHAR(300) NOT NULL,
  -- The document body. Plain text this slice, and TEXT rather than VARCHAR because it is prose a
  -- person types rather than a form field with a column-width rule. Rich text and history are later.
  body               TEXT         NOT NULL,
  created_by_user_id CHAR(36)     NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child
  -- (a document's versions/comments) can reference this row without a cross-tenant path.
  UNIQUE KEY uq_documents_org_id (organization_id, id),
  -- The index a project's documents are listed by: this tenant's documents for this project, in
  -- id (≈ creation) order. Leads with `organization_id` per `07-DATA-MODEL` §9.
  KEY ix_documents_org_project (organization_id, project_id, id),
  CONSTRAINT fk_documents_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_documents_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A document's tenant and project are immutable, for the reason `conversations`' trigger gives:
-- re-pointing a document at another project would move it into a room a different set of people
-- can read, silently. Editing is a change to `title` and `body` and to nothing else.
DELIMITER $$

CREATE TRIGGER trg_documents_immutable
BEFORE UPDATE ON documents FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'documents.organization_id is immutable';
  END IF;
  IF NEW.project_id <> OLD.project_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'documents.project_id is immutable';
  END IF;
  IF NEW.created_by_user_id <> OLD.created_by_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'documents.created_by_user_id is immutable';
  END IF;
END$$

DELIMITER ;
