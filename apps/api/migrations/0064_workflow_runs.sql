-- 0064_workflow_runs — org-scoped record of one execution of a workflow template (Automations &
-- integrations, module 17, x163; extends x162's workflow_templates, 0063).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Automations & integrations
-- ("execution"); 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §Automations; 07-DATA-MODEL §9 (index prefixes
-- lead with `organization_id`); 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## Migration number
--
-- Pass 21 reserves 0060–0080 in slice-id order; x163's reservation is 0064 (pass21-queue header).
-- This slice's base carries 0063 (x162's workflow_templates), so 0064 sits directly above it. The
-- migrator applies files in ascending numeric order and a gap is not an error, so 0064 is correct on
-- this base. If the integration renumbers the reservations, the integrator renumbers this file with
-- them; nothing here depends on the literal 0064 beyond the filename.
--
-- ## What this migration is for
--
-- x162 defined a workflow *template* — a trigger/action pairing at rest. This adds the smallest unit
-- of *execution*: one **run** row recording that a template was run, whether the in-app action
-- succeeded or failed, and a bounded JSON detail of what it did. A run is append-only history: it is
-- created once and read, never edited or removed by a runtime credential (the app is granted INSERT
-- only, below).
--
-- ## Org-scoped, keyed to its template within the tenant
--
-- A run belongs to the organization and to one template. The template reference is the composite
-- `(organization_id, template_id)` foreign key onto `workflow_templates (organization_id, id)` — the
-- unique key 0063 carries precisely so a child cannot reference a template across a tenant boundary.
-- There is no bare `template_id` foreign key: a cross-tenant path must be impossible by construction.
--
-- ## `status` and `detail_json`
--
-- `status` is a short `VARCHAR` validated against a fixed application allowlist (`succeeded` |
-- `failed`) before any INSERT — the same division `workflow_templates.trigger_kind` uses, so the set
-- can grow without an `ALTER TABLE`. `detail_json` is a small bounded object describing the action's
-- outcome (its kind, what it would do), read and written whole with the run, never queried across
-- runs, so it is one `JSON` column rather than a child table. The application bounds its size before
-- the write.
--
-- ## Identity is immutable
--
-- `organization_id` and `template_id` are what a run *is*; the `BEFORE UPDATE` trigger holds them at
-- the engine (ADR-0001 layers 3 and 4 are application-side and a direct SQL session bypasses both),
-- the reason every other identity trigger in this schema exists. The app is granted INSERT only, so
-- no runtime credential updates a run at all; the trigger is the engine-level backstop.

CREATE TABLE workflow_runs (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The template this run executed. Composite-keyed to the template within the same tenant below.
  template_id     CHAR(36)     NOT NULL,
  -- The run's outcome. Validated against a fixed application allowlist (`succeeded` | `failed`)
  -- before any write; the column only ever holds a known token.
  status          VARCHAR(32)  NOT NULL,
  -- A small bounded object describing what the in-app action did. Shape and size are validated by the
  -- application; the column stores it whole.
  detail_json     JSON         NOT NULL,
  started_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries.
  UNIQUE KEY uq_workflow_runs_org_id (organization_id, id),
  -- The index a template's run history is read by: this organization's runs for one template, newest
  -- first. Leads with `organization_id` per 07-DATA-MODEL §9.
  KEY ix_workflow_runs_org_template (organization_id, template_id, started_at),
  CONSTRAINT fk_workflow_runs_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The template, referenced through the composite tenant key so a run cannot point at another
  -- studio's template. Matches the `(organization_id, id)` unique key 0063 declares for this purpose.
  CONSTRAINT fk_workflow_runs_template
    FOREIGN KEY (organization_id, template_id) REFERENCES workflow_templates (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A run's tenant and template are immutable, the reason every identity trigger in this schema gives.
-- The app is granted INSERT only, so this trigger is the engine-level backstop for any other
-- credential; `status`, `detail_json` and the timestamps are what the run recorded and are not
-- amended after the fact.
DELIMITER $$

CREATE TRIGGER trg_workflow_runs_immutable
BEFORE UPDATE ON workflow_runs FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'workflow_runs.organization_id is immutable';
  END IF;
  IF NEW.template_id <> OLD.template_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'workflow_runs.template_id is immutable';
  END IF;
END$$

DELIMITER ;
