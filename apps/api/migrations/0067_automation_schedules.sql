-- 0067_automation_schedules — scheduled triggers for a workflow template (Automations module 17,
-- x167). A cron-like schedule that names *when* a workflow template should run.
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Automations ("scheduled triggers");
-- 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §Automations; 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`); 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## Migration number
--
-- Pass 21 reserves 0060–0080 in slice-id order; x167's reservation is 0067 (NEXT-SCOPES-13 header).
-- This slice bases on master `bcfe397` and extends x162 (workflow templates, migration 0063): the
-- schedule points at a `workflow_templates` row, so the composite foreign key below depends on
-- 0063 having run first. In the integrated sequence 0063 precedes 0067, so the reference resolves;
-- on this slice's standalone base the table is not yet present, which is expected in the
-- file-disjoint model (the DB suite runs post-merge, when every pass-21 migration is present). The
-- migrator applies files in ascending numeric order and a gap is not an error. If the integration
-- renumbers the reservations, the integrator renumbers this file with them; nothing here depends on
-- the literal 0067 beyond the filename.
--
-- ## What this migration is for
--
-- x162 gives an organization reusable workflow templates; x163 runs one on demand. Neither says
-- *when* a template should run on its own. This table is the smallest unit that adds a schedule: a
-- bounded, cron-like recurrence (`hourly` / `daily` / `weekly`, with an hour and day-of-week where
-- the interval uses them), the pre-computed `next_run_at` instant, and an `enabled` flag.
--
-- It is deliberately not the dispatcher: nothing here fires a run. A background runner that wakes on
-- `next_run_at` and enqueues the workflow is worker infrastructure (Needs-Peter); this slice records
-- the schedule and computes the next instant deterministically so that runner has something to read.
--
-- ## Tenant-owned, keyed to a template
--
-- A schedule belongs to the organization and to one of its workflow templates. The tenant key is
-- `(organization_id, template_id)`, bound to `workflow_templates` by a composite foreign key that
-- includes `organization_id`, so a schedule can never point at another tenant's template.
--
-- ## `spec_json` is the recurrence spec
--
-- The recurrence is a small `{ interval, hour?, dayOfWeek? }` object, read and written whole with the
-- schedule and never queried across schedules, so it is one `JSON` column. Its shape and bounds are
-- validated by the application (`next-run.ts`), the division `work_forms.fields_json` (0052) uses.
--
-- ## Identity is immutable
--
-- `organization_id` and `template_id` are what a schedule is; the `BEFORE UPDATE` trigger holds them
-- at the engine, the reason every identity trigger in this schema exists (ADR-0001 layers 3 and 4 are
-- application-side and a direct SQL session bypasses both). This slice grants the app INSERT only: a
-- schedule is created and read; an editor / a per-schedule enable toggle is a later slice with its
-- own grant, so `enabled`, `spec_json` and `next_run_at` are left editable at the engine but never
-- written by a runtime credential yet.

CREATE TABLE automation_schedules (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The workflow template this schedule runs. Bound to workflow_templates by the composite key
  -- below, so it is always one of this tenant's templates.
  template_id     CHAR(36)     NOT NULL,
  -- The recurrence spec: `{ "interval", "hour"?, "dayOfWeek"? }`. Shape validated by the application;
  -- the column stores it whole.
  spec_json       JSON         NOT NULL,
  -- The next instant this schedule should fire, computed deterministically at write time from the
  -- spec and the current instant. A dispatcher reads this; nothing in this slice writes it again.
  next_run_at     DATETIME(3)  NOT NULL,
  -- Whether the schedule is active. Set at creation; a runtime credential cannot flip it yet.
  enabled         TINYINT(1)   NOT NULL DEFAULT 1,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries (isolation corpus requires it).
  UNIQUE KEY uq_automation_schedules_org_id (organization_id, id),
  -- The index the schedules screen lists by: this organization's schedules in due order. Leads with
  -- `organization_id` per 07-DATA-MODEL §9.
  KEY ix_automation_schedules_org_next (organization_id, next_run_at, id),
  CONSTRAINT fk_automation_schedules_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The template, tenant-scoped: the composite key includes organization_id so a schedule cannot
  -- cross a tenant boundary. Depends on workflow_templates (0063, x162) — see the header.
  CONSTRAINT fk_automation_schedules_template_tenant
    FOREIGN KEY (organization_id, template_id) REFERENCES workflow_templates (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A schedule's tenant and template are immutable, the reason `work_forms`' trigger gives. `enabled`,
-- `spec_json` and `next_run_at` are left editable at the engine for a future editor slice; identity
-- is not.
DELIMITER $$

CREATE TRIGGER trg_automation_schedules_immutable
BEFORE UPDATE ON automation_schedules FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'automation_schedules.organization_id is immutable';
  END IF;
  IF NEW.template_id <> OLD.template_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'automation_schedules.template_id is immutable';
  END IF;
END$$

DELIMITER ;
