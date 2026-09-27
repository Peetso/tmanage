-- 0175_work_item_subtasks — a work item's ordered subtasks / breakdown (x307, Work module).
--
-- Governing sources: 38-MODULE-MAP §Work management (checklists/breakdown — the audit's Work
-- "Partial: sub-items"), 22-SCREEN §Work item detail (the ordered subtask checklist with a
-- progress bar), 23-ERD-AND-STATE-MACHINES §2 (tenant-scoped, parent-owned records),
-- 07-DATA-MODEL §9 (index prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- A member breaks one work item into ordered child rows: a titled, done/not-done subtask with a
-- position. Add / list / toggle-or-rename / reorder / delete, plus a read-only done/total roll-up
-- the detail screen renders as a progress bar. There is no state machine on the parent — the
-- roll-up is a count, never a transition.
--
-- ## Distinct from its neighbours
--
-- This is intra-item child rows, not item-to-item edges: `work_item_links` (0085) holds typed
-- relations between items and `work_blockers` a blocking graph, whereas a subtask hangs off exactly
-- one parent. It is also distinct from `work_item_checklist_items` (0051): that table has no
-- author and no delete; this one records `created_by` and is removable.
--
-- ## Parent- and tenant-scoped
--
-- A subtask belongs to one work item of one studio. `organization_id` scopes it to the tenant; the
-- composite foreign key `fk_work_item_subtasks_parent` binds `(organization_id, parent_work_item_id)`
-- to `work_items (organization_id, id)`, so a subtask can only ever name a work item of its own
-- tenant — a cross-tenant `parent_work_item_id` does not exist as a pair even when both ids exist
-- individually. That is the engine half of the trap the service also enforces in code: a
-- cross-tenant parent is a 404, never a write.
--
-- ## `position` orders; `is_done` is a flag
--
-- `position` is a plain ordinal the list is read by (ascending), seeded by the service at insert
-- time and movable by an edit. `is_done` is `TINYINT(1)` — 0 not done, 1 done — toggled in place.
-- `title`, `is_done` and `position` are editable; identity is not (see the trigger).
--
-- ## Identity is immutable
--
-- `organization_id` and `parent_work_item_id` are what a subtask *is*: moving it to another studio
-- or re-parenting it to another work item is not an edit. The `BEFORE UPDATE` trigger holds that at
-- the engine — ADR-0001 layers 3 and 4 are application-side and a direct SQL session bypasses both.

CREATE TABLE work_item_subtasks (
  id                    CHAR(36)     NOT NULL,
  organization_id       CHAR(36)     NOT NULL,
  parent_work_item_id   CHAR(36)     NOT NULL,
  -- `work_items.title` is VARCHAR(300); a subtask title is the same kind of short handle.
  title                 VARCHAR(300) NOT NULL,
  -- 0 = not done, 1 = done. Toggled in place.
  is_done               TINYINT(1)   NOT NULL DEFAULT 0,
  -- The ordinal the list is read by, ascending. Seeded at insert; movable by an edit.
  position              INT UNSIGNED NOT NULL DEFAULT 0,
  -- The membership user who added the subtask. Recorded for provenance; never rewritten.
  created_by            CHAR(36)     NOT NULL,
  created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_work_item_subtasks_org_id (organization_id, id),
  -- The index the panel's list is served by: this tenant's subtasks for one work item, in
  -- position (then id) order. Leads with `organization_id` per `07-DATA-MODEL` §9.
  KEY ix_work_item_subtasks_parent (organization_id, parent_work_item_id, position, id),
  -- A subtask can only ever name a work item of its own tenant; the composite key is what makes a
  -- cross-tenant `parent_work_item_id` a non-existent pair rather than a leak.
  CONSTRAINT fk_work_item_subtasks_parent
    FOREIGN KEY (organization_id, parent_work_item_id) REFERENCES work_items (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A subtask's tenant and parent are immutable, for the reason the checklist trigger gives:
-- re-parenting it or moving it to another studio would change what it is, silently. Editing is a
-- change to `title`, `is_done` and `position` and to nothing else.
DELIMITER $$

CREATE TRIGGER trg_work_item_subtasks_immutable
BEFORE UPDATE ON work_item_subtasks FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_subtasks.organization_id is immutable';
  END IF;
  IF NEW.parent_work_item_id <> OLD.parent_work_item_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_subtasks.parent_work_item_id is immutable';
  END IF;
END$$

DELIMITER ;
