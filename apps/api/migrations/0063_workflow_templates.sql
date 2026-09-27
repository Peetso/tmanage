-- 0063_workflow_templates — org-scoped automation workflow templates (Automations & integrations,
-- module 17, x162).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Automations & integrations ("workflow
-- templates"); 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §Automations; 07-DATA-MODEL §9 (index prefixes
-- lead with `organization_id`); 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## Migration number
--
-- Pass 21 reserves 0060–0080 in slice-id order; x162's reservation is 0063 (pass21-queue header).
-- The highest migration present on this slice's base (master bcfe397) is 0052; 0053–0062 are reserved
-- by sibling pass-21 branches not yet integrated, so 0063 sits above every reservation. The migrator
-- applies files in ascending numeric order and a gap is not an error (it rejects only a NEW file
-- numbered *below* an applied one), so 0063 on top of 0052 is correct on this base. If the
-- integration renumbers the reservations, the integrator renumbers this file with them; nothing here
-- depends on the literal 0063 beyond the filename.
--
-- ## What this migration is for
--
-- The Automations module has no persistence yet. This is the smallest useful unit that adds one — an
-- **org-scoped workflow template**: a named, disabled-or-enabled pairing of a *trigger* ("when this
-- happens") and an *action* ("do this"), plus a bounded JSON config the action reads. It is a
-- *definition* at rest, not a run: nothing executes a template in this slice (execution/runs are
-- x163). The template only records what an automation *would* do.
--
-- `trigger_kind` and `action_kind` are validated against a fixed application allowlist
-- (`templates.controller.ts`) before any INSERT, so an off-list value is a 400 with no write and the
-- column only ever holds a known token. They are stored as short `VARCHAR`s rather than as a MySQL
-- `ENUM` so the allowlist can grow without an `ALTER TABLE`; the application is the source of truth
-- for the closed set, the same division `saved_views.config` (0034) and `work_forms.fields_json`
-- (0052) use for their typed values.
--
-- ## Org-scoped, not project-owned
--
-- Like `document_templates` (0039) and `work_forms` (0052), a workflow template belongs to the
-- organization, not a project: automations are an org-admin concern (`org.manage`). So there is no
-- `project_id` and no project composite foreign key — the tenant key is `organization_id` alone,
-- bound to `organizations`.
--
-- ## `config_json` is a bounded JSON object
--
-- The action's configuration is a small object read and written whole with the template, never
-- queried across templates, so it is one `JSON` column rather than a child table. Its size and shape
-- are bounded by the application before the write; the column stores it whole.
--
-- ## Identity is immutable
--
-- `organization_id` and `created_by` are what a template is; the `BEFORE UPDATE` trigger holds them
-- at the engine, the reason every other identity trigger in this schema exists (ADR-0001 layers 3 and
-- 4 are application-side and a direct SQL session bypasses both). This slice grants the app INSERT
-- only (no UPDATE, no DELETE): a template is created and read, never edited or removed by a runtime
-- credential — an editor and an enable/disable toggle are later slices with their own grants.

CREATE TABLE workflow_templates (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- A short handle for the template, like `work_forms.name` (VARCHAR(300)).
  name            VARCHAR(300) NOT NULL,
  -- The event that would fire the automation. Validated against a fixed application allowlist before
  -- any write; the column only ever holds a known token.
  trigger_kind    VARCHAR(64)  NOT NULL,
  -- What the automation would do. Validated against a fixed application allowlist before any write.
  action_kind     VARCHAR(64)  NOT NULL,
  -- The action's configuration, a small bounded object. Shape and size are validated by the
  -- application; the column stores it whole.
  config_json     JSON         NOT NULL,
  -- Whether the template is active. Set at INSERT time this slice (no toggle endpoint yet); an
  -- enable/disable path is a later slice that adds UPDATE with the code that writes it.
  enabled         BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by      CHAR(36)     NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child (a run) can
  -- reference this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_workflow_templates_org_id (organization_id, id),
  -- The index a tenant's templates are listed by: this organization's templates in name order.
  -- Leads with `organization_id` per 07-DATA-MODEL §9.
  KEY ix_workflow_templates_org_name (organization_id, name, id),
  CONSTRAINT fk_workflow_templates_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The actor. References users (id) without organization_id because a user is not tenant-owned —
  -- the same shape `work_forms.created_by` (0052) uses.
  CONSTRAINT fk_workflow_templates_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A template's tenant and author are immutable, the reason `work_forms`' trigger gives. `name`,
-- `trigger_kind`, `action_kind`, `config_json` and `enabled` are left editable at the engine for a
-- future editor/toggle slice; identity is not.
DELIMITER $$

CREATE TRIGGER trg_workflow_templates_immutable
BEFORE UPDATE ON workflow_templates FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'workflow_templates.organization_id is immutable';
  END IF;
  IF NEW.created_by <> OLD.created_by THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'workflow_templates.created_by is immutable';
  END IF;
END$$

DELIMITER ;
