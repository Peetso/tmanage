-- 0182_meeting_agenda_templates — reusable meeting agenda templates (CAL, x314).
--
-- Governing sources: 38-MODULE-MAP §Calendar & meetings (agenda templates); 22-SCREEN §Meeting
-- detail. The nearest precedents are 0052 work_forms (an org-scoped, name + ordered-JSON-list
-- definition a later action instantiates) and 0043 meeting_series (org-scoped, meeting.* gated,
-- names no project).
--
-- ## Migration numbering
--
-- Numbered 0182 as reserved by the pass-26 queue map (x314=0182). The number is a set member, not
-- a position (migrator.db.test treats gaps as legitimate); the integrator renumbers only on a
-- collision after the parallel pass-26 merges.
--
-- ## What this table is, and what it deliberately is not
--
-- One row per **reusable agenda template** — a rule, not an event. A template carries a `name` and
-- an ordered list of agenda items (`items_json`: `[{ "title", "position" }, …]`), org-scoped and
-- NOT project-owned: like a `meeting_series` (0043) it names no project, so it is read/written
-- behind `meeting.read`/`meeting.write` at the tenant level with no project relation to check.
--
-- Applying a template seeds a meeting's existing per-meeting item store (`meeting_notes`, 0033,
-- kind `note`) — this table adds no per-meeting rows and no foreign key to any meeting. The apply
-- is idempotent in the service: a template item whose title already exists as a note on the target
-- meeting is skipped, so re-applying never duplicates identical titles.
--
-- ## items_json is JSON; name/items non-empty is the application's rule
--
-- `items_json` stores the ordered item list whole, validated by the application (work_forms.fields_json
-- precedent). An empty name or empty item list is a 400 with no insert (enforced in the controller);
-- the column itself is NOT NULL and holds a well-formed array.
--
-- ## Tenant scope and lifecycle
--
-- `(organization_id, id)` is unique so a future child can reference a template with a composite
-- foreign key bound to the same tenant, never a cross-tenant path — the arrangement every scoped
-- table here carries. This slice creates, lists, edits (idempotent PUT) and removes (DELETE) a
-- template, so the runtime credential holds INSERT, UPDATE and DELETE (scripts/db/users.sql) and
-- `updated_at` tracks the last edit. A BEFORE UPDATE trigger pins the immutable identity columns
-- (`organization_id`, `created_by`, `created_at`), the arrangement 0034 saved_views carries.

CREATE TABLE meeting_agenda_templates (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  -- `work_forms.name` is VARCHAR(300); an agenda template name is the same kind of short handle.
  name             VARCHAR(300) NOT NULL,
  -- The ordered list of agenda items: `[{ "title", "position" }, …]`. Shape is validated by the
  -- application; the column stores it whole (work_forms.fields_json precedent).
  items_json       JSON         NOT NULL,
  created_by       CHAR(36)     NOT NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_meeting_agenda_templates_org_id (organization_id, id),
  -- The index a tenant's templates are listed by: this organization's templates in name order.
  -- Leads with `organization_id` per 07-DATA-MODEL §9.
  KEY ix_meeting_agenda_templates_org_name (organization_id, name, id),
  CONSTRAINT fk_meeting_agenda_templates_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The actor. References users (id) without organization_id because a user is not tenant-owned —
  -- the same shape `work_forms.created_by` (0052) uses.
  CONSTRAINT fk_meeting_agenda_templates_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_meeting_agenda_templates_immutable
BEFORE UPDATE ON meeting_agenda_templates FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_agenda_templates.organization_id is immutable';
  END IF;
  IF NEW.created_by <> OLD.created_by THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_agenda_templates.created_by is immutable';
  END IF;
  IF NEW.created_at <> OLD.created_at THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_agenda_templates.created_at is immutable';
  END IF;
END$$

DELIMITER ;
