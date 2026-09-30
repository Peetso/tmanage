-- 0201_automation_template_tags — org-scoped free-text tags on a workflow template, so a studio can
-- categorise its automation templates and filter them by label (Automations & integrations, module 17,
-- x335; extends x162's workflow_templates, 0063).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Automations & integrations (template
-- organisation); 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §Automations; 07-DATA-MODEL §9 (index prefixes
-- lead with `organization_id`); 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## Migration number
--
-- Pass 26 reserves 0174–0201 in slice-id order; x335's reservation is 0201 (pass26-queue header map).
-- The migrator applies files in ascending numeric order and a gap is not an error (it rejects only a
-- NEW file numbered *below* an applied one), so 0201 sitting above the automations tables (0063/0081)
-- is correct on this base. If the integration renumbers the reservations, the integrator renumbers
-- this file with them; nothing here depends on the literal 0201 beyond the filename.
--
-- ## What this migration is for
--
-- x162 defined a workflow *template* and x189 let it be edited, but there is no way to organise the
-- set: a studio with many templates cannot categorise or find them. This adds the smallest useful unit
-- — a **tag**: a short free-text label attached to one template. A template can carry several tags; a
-- tag can be added and removed, and the template list can be filtered by one. A tag is a label at
-- rest: it is created and deleted, never edited (a re-label is a delete and a re-add, the person_skills
-- posture, 0070); the app is granted INSERT and DELETE only.
--
-- ## Org-scoped, keyed to its template within the tenant
--
-- A tag belongs to the organization and to one template. The template reference is the composite
-- `(organization_id, workflow_template_id)` foreign key onto `workflow_templates (organization_id, id)`
-- — the unique key 0063 carries precisely so a child cannot reference a template across a tenant
-- boundary. There is no bare `workflow_template_id` foreign key: a cross-tenant path must be impossible
-- by construction.
--
-- ## One tag per (template, label), case-insensitively
--
-- A template carrying the same label twice is a mistake, not two tags, so `(organization_id,
-- workflow_template_id, label)` is UNIQUE. The table's `utf8mb4_unicode_ci` collation makes that
-- uniqueness case- and accent-insensitive, so `Urgent` and `urgent` collide — the case-folding the
-- scope's `lower(label)` intends, achieved by the collation the way `person_skills` (0070) achieves it,
-- rather than a functional index. The application normalises the label (trims, single-spaces) before
-- the insert and turns the duplicate-key violation into a 409.
--
-- ## Identity is immutable
--
-- `organization_id`, `workflow_template_id`, `label` and `created_by` are what a tag *is*; the
-- `BEFORE UPDATE` trigger holds them at the engine (ADR-0001 layers 3 and 4 are application-side and a
-- direct SQL session bypasses both), the reason every other identity trigger in this schema exists. The
-- app is granted INSERT and DELETE only, so no runtime credential updates a tag at all; the trigger is
-- the engine-level backstop.

CREATE TABLE automation_template_tags (
  id                   CHAR(36)     NOT NULL,
  organization_id      CHAR(36)     NOT NULL,
  -- The template this tag categorises. Composite-keyed to the template within the same tenant below.
  workflow_template_id CHAR(36)     NOT NULL,
  -- The tag's short free-text label, normalised (trimmed, single-spaced) by the application before
  -- insert. The `utf8mb4_unicode_ci` collation makes the uniqueness below case-insensitive.
  label                VARCHAR(80)  NOT NULL,
  created_by           CHAR(36)     NOT NULL,
  created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries.
  UNIQUE KEY uq_automation_template_tags_org_id (organization_id, id),
  -- One tag per (template, label): a duplicate label is a 409, not a second row. Case-insensitive via
  -- the table collation.
  UNIQUE KEY uq_automation_template_tags_label (organization_id, workflow_template_id, label),
  -- The index a template's tags are read by, and the tag filter joins on: this organization's tags for
  -- one template, in label order. Leads with `organization_id` per 07-DATA-MODEL §9.
  KEY ix_automation_template_tags_template (organization_id, workflow_template_id, label),
  CONSTRAINT fk_automation_template_tags_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The template, referenced through the composite tenant key so a tag cannot point at another
  -- studio's template. Matches the `(organization_id, id)` unique key 0063 declares for this purpose.
  CONSTRAINT fk_automation_template_tags_template
    FOREIGN KEY (organization_id, workflow_template_id) REFERENCES workflow_templates (organization_id, id),
  -- The actor. References users (id) without organization_id because a user is not tenant-owned —
  -- the same shape `workflow_templates.created_by` (0063) uses.
  CONSTRAINT fk_automation_template_tags_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A tag's tenant, template, label and author are immutable — a re-label is a delete and a re-add, the
-- reason every identity trigger in this schema gives. The app is granted INSERT and DELETE only, so
-- this trigger is the engine-level backstop for any other credential.
DELIMITER $$

CREATE TRIGGER trg_automation_template_tags_immutable
BEFORE UPDATE ON automation_template_tags FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'automation_template_tags.organization_id is immutable';
  END IF;
  IF NEW.workflow_template_id <> OLD.workflow_template_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'automation_template_tags.workflow_template_id is immutable';
  END IF;
  IF NEW.label <> OLD.label THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'automation_template_tags.label is immutable';
  END IF;
  IF NEW.created_by <> OLD.created_by THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'automation_template_tags.created_by is immutable';
  END IF;
END$$

DELIMITER ;
