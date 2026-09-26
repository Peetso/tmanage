-- 0051_work_item_checklist_items — a work item's checklist / sub-items (x145, Work module 7).
--
-- Governing sources: 38-MODULE-MAP §Work (checklists/subtasks — the audit's "Work Partial:
-- sub-items not built"), 23-ERD-AND-STATE-MACHINES §2 (tenant-scoped, parent-owned records),
-- 07-DATA-MODEL §9 (index prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- WORK-001 stores the work item; its detail screen (TM-13) names a "checklist" among the
-- sections that are their own object and were not yet built. This is that object at its
-- smallest useful size: a labelled, ordered list of done/not-done sub-items hanging off one
-- work item. Add / list / toggle-or-rename, and nothing more — reorder persistence beyond the
-- stored `position` and a per-item assignee are deferred to NS-13, the mistake `0007` refused
-- when it left out a column with nothing to reference yet.
--
-- ## Parent- and tenant-scoped
--
-- A checklist item belongs to one work item of one studio. `organization_id` scopes it to the
-- tenant, the way every sibling table is scoped; the composite foreign key
-- `fk_work_item_checklist_items_work_item` binds `(organization_id, work_item_id)` to
-- `work_items (organization_id, id)`, so a checklist item can only ever name a work item of its
-- own tenant — a cross-tenant `work_item_id` does not exist as a pair even when both ids exist
-- individually. That is the engine half of the trap the service also enforces in code: a
-- cross-tenant parent is a 404, never a write.
--
-- ## `position` orders; `done` is a flag
--
-- `position` is a plain ordinal the list is read by (ascending), seeded by the service at
-- insert time. `done` is `TINYINT(1)` — 0 not done, 1 done — toggled in place. Both are
-- editable; identity is not (see the trigger).
--
-- ## Identity is immutable
--
-- `organization_id` and `work_item_id` are what a checklist item *is*: moving it to another
-- studio or re-parenting it to another work item is not an edit. The `BEFORE UPDATE` trigger
-- holds that at the engine — ADR-0001 layers 3 and 4 are application-side and a direct SQL
-- session bypasses both. `label`, `done` and `position` are editable; identity is not.

CREATE TABLE work_item_checklist_items (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  work_item_id       CHAR(36)     NOT NULL,
  -- `work_items.title` is VARCHAR(300); a checklist label is the same kind of short handle.
  label              VARCHAR(300) NOT NULL,
  -- 0 = not done, 1 = done. Toggled in place.
  done               TINYINT(1)   NOT NULL DEFAULT 0,
  -- The ordinal the list is read by, ascending. Seeded at insert; reorder persistence is NS-13.
  position           INT UNSIGNED NOT NULL DEFAULT 0,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_work_item_checklist_items_org_id (organization_id, id),
  -- The index the panel's list is served by: this tenant's items for one work item, in
  -- position (then id) order. Leads with `organization_id` per `07-DATA-MODEL` §9.
  KEY ix_work_item_checklist_items_item (organization_id, work_item_id, position, id),
  -- A checklist item can only ever name a work item of its own tenant; the composite key is
  -- what makes a cross-tenant `work_item_id` a non-existent pair rather than a leak.
  CONSTRAINT fk_work_item_checklist_items_work_item
    FOREIGN KEY (organization_id, work_item_id) REFERENCES work_items (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A checklist item's tenant and parent are immutable, for the reason `saved_views`' trigger
-- gives: re-parenting it or moving it to another studio would change what it is, silently.
-- Editing is a change to `label`, `done` and `position` and to nothing else.
DELIMITER $$

CREATE TRIGGER trg_work_item_checklist_items_immutable
BEFORE UPDATE ON work_item_checklist_items FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_checklist_items.organization_id is immutable';
  END IF;
  IF NEW.work_item_id <> OLD.work_item_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_checklist_items.work_item_id is immutable';
  END IF;
END$$

DELIMITER ;
