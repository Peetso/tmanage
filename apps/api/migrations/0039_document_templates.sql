-- 0039_document_templates — org-scoped document templates (DOC-04 / ADM-06, x119).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Docs and knowledge" ("Documents,
-- briefs, wiki, **templates**, decision register …") and §Administration ("… fields, **templates**
-- …"); 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX DOC-04 (template gallery/editor — purpose-led previews)
-- + ADM-06 (templates/workflows — document templates); 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`); 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## Migration number
--
-- The highest migration on this slice's base (x112, `document_versions` 0036) is 0036. 0037 and
-- 0038 are reserved on other branches in flight (x117 reserved 0038), so this is named 0039 to sit
-- above them and avoid a collision; the integrator renumbers if the merge order differs.
--
-- ## What this migration is for
--
-- The `/docs` hub advertises "templates" (DOC-01), but no table can hold one and no route creates
-- one. This is the smallest useful unit that changes that: an **org-scoped document template** — a
-- name, a purpose, and a reusable body — that a person applies to a project to seed a new document.
-- It is deliberately *not* the whole of the DOC-04 vision: there is no variable/placeholder
-- substitution and no per-template permission (both DOC-04 advanced, deferred to NEXT-SCOPES-11),
-- and no project/work-item templates (ADM-06's other kinds). This table carries only what a
-- document template *is* at rest.
--
-- ## Org-scoped, not project-owned
--
-- Unlike `documents` (0030), a template belongs to the organization, not a project: it is a
-- reusable starting point any project can apply. So there is no `project_id` and no project
-- composite foreign key — the tenant key is `organization_id` alone, bound to `organizations`. The
-- act of applying a template creates an ordinary `documents` row in a project (see the service);
-- the template itself is never moved into a project and is never mutated by an apply.
--
-- ## `body` is plain text this slice
--
-- A template body is prose a person types, so it is `TEXT` and `NOT NULL` — the same choice
-- `documents.body` (0030) made. Rich text and variable substitution are later slices, not columns
-- added before the code that fills them exists.
--
-- ## Identity is immutable, and history is forward-only
--
-- `organization_id` and `created_by_user_id` are what a template is; the `BEFORE UPDATE` trigger
-- holds them at the engine, the reason every other trigger in this schema exists (ADR-0001 layers 3
-- and 4 are application-side and a direct SQL session bypasses both). This slice grants the app
-- INSERT only (no UPDATE, no DELETE): a template is created and read, never edited or removed by a
-- runtime credential — an editor is a later slice with its own grant.

CREATE TABLE document_templates (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- A short handle for the template, like `documents.title` (VARCHAR(300)).
  name               VARCHAR(300) NOT NULL,
  -- The purpose-led preview DOC-04 calls for: one line saying what this template is for.
  purpose            VARCHAR(300) NOT NULL,
  -- The reusable body a new document is seeded from. Plain text like `documents.body` (0030).
  body               TEXT         NOT NULL,
  created_by_user_id CHAR(36)     NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_document_templates_org_id (organization_id, id),
  -- The index a tenant's templates are listed by: this organization's templates in name order.
  -- Leads with `organization_id` per 07-DATA-MODEL §9.
  KEY ix_document_templates_org_name (organization_id, name, id),
  CONSTRAINT fk_document_templates_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The actor. References users (id) without organization_id because a user is not tenant-owned —
  -- the same shape `import_jobs.created_by_user_id` (0028) uses.
  CONSTRAINT fk_document_templates_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A template's tenant and author are immutable, the reason `documents`' trigger gives. `name`,
-- `purpose` and `body` are left editable at the engine for a future editor slice; identity is not.
DELIMITER $$

CREATE TRIGGER trg_document_templates_immutable
BEFORE UPDATE ON document_templates FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'document_templates.organization_id is immutable';
  END IF;
  IF NEW.created_by_user_id <> OLD.created_by_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'document_templates.created_by_user_id is immutable';
  END IF;
END$$

DELIMITER ;
