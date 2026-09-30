-- 0159_work_checklist_templates — reusable work-item checklist templates (x292, Work module 7).
--
-- Governing sources: 22-SCREEN WORK checklists, 38-MODULE-MAP §Work management, 11-USER-STORIES
-- (work templates), 23-ERD-AND-STATE-MACHINES §2 (tenant-scoped records), 07-DATA-MODEL §9 (index
-- prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite keys).
--
-- ## What this migration is for
--
-- The Work module builds a per-item checklist (0051), but there was no way to define a named,
-- reusable set of checklist labels once and seed a work item's checklist from it. This is that
-- object at its smallest useful size: define a template (a name and an ordered list of item labels)
-- once per studio, then apply it to a work item to seed that item's checklist.
--
-- ## One org-scoped definition table
--
-- `work_checklist_templates` holds the templates. `name` is unique per tenant
-- (`uq_work_checklist_templates_org_name`) so a duplicate define is a 409. `labels_json` holds the
-- ordered array of label strings whole — it is validated and length-bounded by the application
-- before the write, so the column only ever holds a small, well-formed array of short strings
-- (the same division `saved_searches.filters` and `home_widget_prefs.widget_order_json` take).
-- Applying a template writes rows into `work_item_checklist_items` (0051); this table stores only
-- the reusable definition.
--
-- ## Tenant-scoped
--
-- Every row belongs to one studio. `organization_id` scopes every row and
-- `fk_work_checklist_templates_org` binds it to `organizations (id)`. `created_by` records the
-- membership that defined the template (informational; NULL-able, no cross-tenant path).
--
-- ## Identity is immutable
--
-- `organization_id` is what a row *is* — moving it to another studio is not an edit. The
-- `BEFORE UPDATE` trigger holds that at the engine, the way `work_item_labels` (0105) does;
-- ADR-0001 layers 3 and 4 are application-side and a direct SQL session bypasses both.

CREATE TABLE work_checklist_templates (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  -- The template's display name, unique per tenant.
  name             VARCHAR(120) NOT NULL,
  -- The ordered list of checklist item labels, as a validated, bounded JSON array of short
  -- strings. The application validates and bounds it before the write.
  labels_json      JSON         NOT NULL,
  -- The membership that defined the template; NULL if the actor is not known. No FK: informational.
  created_by       CHAR(36)     NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries (25-AUTH §6).
  UNIQUE KEY uq_work_checklist_templates_org_id (organization_id, id),
  -- A template's name is unique per studio; a duplicate define is a 409.
  UNIQUE KEY uq_work_checklist_templates_org_name (organization_id, name),
  -- The listing index: this tenant's templates, name-ascending. Leads with `organization_id`
  -- per 07-DATA-MODEL §9.
  KEY ix_work_checklist_templates_org (organization_id, name, id),
  CONSTRAINT fk_work_checklist_templates_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A template row's tenant is immutable, for the reason `work_item_labels`' trigger gives: moving
-- it to another studio would change what it is, silently.
DELIMITER $$

CREATE TRIGGER trg_work_checklist_templates_immutable
BEFORE UPDATE ON work_checklist_templates FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_checklist_templates.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
