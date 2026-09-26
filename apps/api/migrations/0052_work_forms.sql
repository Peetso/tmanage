-- 0052_work_forms — org-scoped work intake forms (Work module 7, WORK forms, x146).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Work ("intake forms" — a reusable
-- form definition and create-from-form); 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §Work; 07-DATA-MODEL
-- §9 (index prefixes lead with `organization_id`); 25-AUTHORIZATION-AND-TENANT-ISOLATION §6
-- (composite tenant keys).
--
-- ## Migration number
--
-- Pass 20 reserves 0042–0059 in slice-id order; x146's reservation is 0052 (NEXT-SCOPES-12 header).
-- The highest migration present on this slice's base (master 4f80ed1) is 0039; 0040–0051 are
-- reserved by sibling pass-20 branches not yet integrated, so 0052 sits above every reservation.
-- The migrator applies files in ascending numeric order and a gap is not an error (it rejects only a
-- NEW file numbered *below* an applied one), so 0052 on top of 0039 is correct on this base. If the
-- integration renumbers the reservations, the integrator renumbers this file with them; nothing here
-- depends on the literal 0052 beyond the filename.
--
-- ## What this migration is for
--
-- The Work module can create work items directly, but has no *reusable intake form*: a named
-- definition of the fields an intake should capture, from which a work item is created. This is the
-- smallest useful unit that adds one — an **org-scoped work form**: a name and a JSON list of field
-- definitions (label/type/required). Submitting a form validates a payload against those fields and
-- creates an ordinary work item via the existing work service; the form itself is never mutated.
--
-- It is deliberately *not* the whole vision: there is no submission-history table (a submission's
-- durable output is the work item it creates) and no conditional fields — both deferred to
-- NEXT-SCOPES-13. This table carries only what a work form *is* at rest.
--
-- ## Org-scoped, not project-owned
--
-- Like `document_templates` (0039), a work form belongs to the organization, not a project: it is a
-- reusable intake any project's work can be created from. So there is no `project_id` and no project
-- composite foreign key — the tenant key is `organization_id` alone, bound to `organizations`. The
-- act of submitting a form creates a `work_items` row in the project the submission names (see the
-- controller); the form itself is never moved into a project and is never mutated by a submission.
--
-- ## `fields_json` is a JSON list of field definitions
--
-- A form's fields are a small, ordered list of `{ label, type, required }` objects, so they are one
-- `JSON` column rather than a child table: they are read and written as a whole with the form, never
-- queried across forms. Validation of the shape is the application's (`work-forms.validate.ts`), the
-- same division `saved_views.config` (0034) uses for its typed JSON.
--
-- ## Identity is immutable
--
-- `organization_id` and `created_by` are what a form is; the `BEFORE UPDATE` trigger holds them at
-- the engine, the reason every other identity trigger in this schema exists (ADR-0001 layers 3 and 4
-- are application-side and a direct SQL session bypasses both). This slice grants the app INSERT only
-- (no UPDATE, no DELETE): a form is created and read, never edited or removed by a runtime credential
-- — an editor is a later slice with its own grant.

CREATE TABLE work_forms (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- A short handle for the form, like `document_templates.name` (VARCHAR(300)).
  name            VARCHAR(300) NOT NULL,
  -- The ordered list of field definitions: `[{ "label", "type", "required" }, …]`. Shape is
  -- validated by the application; the column stores it whole.
  fields_json     JSON         NOT NULL,
  created_by      CHAR(36)     NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_work_forms_org_id (organization_id, id),
  -- The index a tenant's forms are listed by: this organization's forms in name order. Leads with
  -- `organization_id` per 07-DATA-MODEL §9.
  KEY ix_work_forms_org_name (organization_id, name, id),
  CONSTRAINT fk_work_forms_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The actor. References users (id) without organization_id because a user is not tenant-owned —
  -- the same shape `document_templates.created_by_user_id` (0039) uses.
  CONSTRAINT fk_work_forms_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A form's tenant and author are immutable, the reason `document_templates`' trigger gives. `name`
-- and `fields_json` are left editable at the engine for a future editor slice; identity is not.
DELIMITER $$

CREATE TRIGGER trg_work_forms_immutable
BEFORE UPDATE ON work_forms FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_forms.organization_id is immutable';
  END IF;
  IF NEW.created_by <> OLD.created_by THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_forms.created_by is immutable';
  END IF;
END$$

DELIMITER ;
