-- 0081_workflow_conditions — org-scoped per-step conditions that gate a workflow template's actions
-- (Automations & integrations, module 17, x190; extends x162's workflow_templates, 0063).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Automations & integrations
-- ("conditions / branching"); 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §Automations; 07-DATA-MODEL §9
-- (index prefixes lead with `organization_id`); 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite
-- tenant keys).
--
-- ## Migration number
--
-- Pass 22 reserves 0081–0093 in slice-id order; x190's reservation is 0081 (NEXT-SCOPES-14 header).
-- The migrator applies files in ascending numeric order and a gap is not an error (it rejects only a
-- NEW file numbered *below* an applied one), so 0081 sitting above the automations tables (0063/0064)
-- is correct on this base. If the integration renumbers the reservations, the integrator renumbers
-- this file with them; nothing here depends on the literal 0081 beyond the filename.
--
-- ## What this migration is for
--
-- x162 defined a workflow *template* (a trigger/action pairing); x163 *ran* one. Steps run
-- unconditionally — there is no condition model. This adds the smallest useful unit of *branching*: a
-- per-step **condition** — a `(field, op, value)` predicate bound to a `target_step` — that the run
-- evaluator (x163) reads to decide whether that step fires. A condition is a definition at rest; it is
-- created and read, never edited or removed by a runtime credential (the app is granted INSERT only,
-- below).
--
-- ## Org-scoped, keyed to its template within the tenant
--
-- A condition belongs to the organization and to one template. The template reference is the composite
-- `(organization_id, template_id)` foreign key onto `workflow_templates (organization_id, id)` — the
-- unique key 0063 carries precisely so a child cannot reference a template across a tenant boundary.
-- There is no bare `template_id` foreign key: a cross-tenant path must be impossible by construction.
--
-- ## `op` is a bounded token
--
-- `op` is a short `VARCHAR` validated against a fixed application allowlist (`eq` | `neq` | `gt` | `lt`
-- | `contains`) before any INSERT — the same division `workflow_templates.trigger_kind` uses, so the
-- set can grow without an `ALTER TABLE`. `field` and `value` are bounded strings the application size-
-- checks before the write; `target_step` is a non-negative step index the application bounds.
--
-- ## Identity is immutable
--
-- `organization_id`, `template_id` and `created_by` are what a condition *is*; the `BEFORE UPDATE`
-- trigger holds them at the engine (ADR-0001 layers 3 and 4 are application-side and a direct SQL
-- session bypasses both), the reason every other identity trigger in this schema exists. The app is
-- granted INSERT only, so no runtime credential updates a condition at all; the trigger is the
-- engine-level backstop.

CREATE TABLE workflow_conditions (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The template this condition gates. Composite-keyed to the template within the same tenant below.
  template_id     CHAR(36)     NOT NULL,
  -- The event field the predicate reads (e.g. `priority`, `status`). A bounded string the application
  -- size-checks before the write.
  field           VARCHAR(200) NOT NULL,
  -- The comparison operator. Validated against a fixed application allowlist (`eq` | `neq` | `gt` |
  -- `lt` | `contains`) before any write; the column only ever holds a known token.
  op              VARCHAR(16)  NOT NULL,
  -- The value the field is compared against. A bounded string; numeric operators parse it at
  -- evaluation time.
  value           VARCHAR(500) NOT NULL,
  -- The step this condition governs — a non-negative step index the application bounds. The evaluator
  -- fires the step only when the predicate holds.
  target_step     INT UNSIGNED NOT NULL,
  created_by      CHAR(36)     NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries.
  UNIQUE KEY uq_workflow_conditions_org_id (organization_id, id),
  -- The index a template's conditions are read by: this organization's conditions for one template,
  -- in step order. Leads with `organization_id` per 07-DATA-MODEL §9.
  KEY ix_workflow_conditions_org_template (organization_id, template_id, target_step),
  CONSTRAINT fk_workflow_conditions_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The template, referenced through the composite tenant key so a condition cannot point at another
  -- studio's template. Matches the `(organization_id, id)` unique key 0063 declares for this purpose.
  CONSTRAINT fk_workflow_conditions_template
    FOREIGN KEY (organization_id, template_id) REFERENCES workflow_templates (organization_id, id),
  -- The actor. References users (id) without organization_id because a user is not tenant-owned —
  -- the same shape `workflow_templates.created_by` (0063) uses.
  CONSTRAINT fk_workflow_conditions_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A condition's tenant, template and author are immutable, the reason every identity trigger in this
-- schema gives. The app is granted INSERT only, so this trigger is the engine-level backstop for any
-- other credential; `field`, `op`, `value` and `target_step` are what the condition recorded and are
-- left editable at the engine for a future editor slice that adds UPDATE with the code that writes it.
DELIMITER $$

CREATE TRIGGER trg_workflow_conditions_immutable
BEFORE UPDATE ON workflow_conditions FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'workflow_conditions.organization_id is immutable';
  END IF;
  IF NEW.template_id <> OLD.template_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'workflow_conditions.template_id is immutable';
  END IF;
  IF NEW.created_by <> OLD.created_by THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'workflow_conditions.created_by is immutable';
  END IF;
END$$

DELIMITER ;
