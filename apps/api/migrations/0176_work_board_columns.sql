-- 0176_work_board_columns — an organization's custom work-board columns (x308, Work module 7).
--
-- Governing sources: 38-MODULE-MAP §Work management (board views — the audit's "board renders
-- the fixed default states, no org-chosen columns"), 22-SCREEN §Work board, 23-ERD-AND-STATE-
-- MACHINES §2 (tenant-scoped records), 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- A studio may want the board grouped by columns of its own choosing rather than the fixed
-- default states. This is that layout at its smallest useful size: an ordered list of columns,
-- each a label and the work-state key it groups. It is a **display grouping over existing
-- states** — it changes nothing about the work-item state machine, adds no new state, and stores
-- no work item. `state_key` names one of the machine's states; the allowlist is enforced in the
-- service (a value off it is a 400 with no write), so a state added to the machine needs no
-- schema change here.
--
-- ## Org-scoped, one layer of columns per studio
--
-- A column belongs to one studio and to no work item. `organization_id` scopes it the way every
-- sibling table is scoped, and the `(organization_id, id)` key is what every tenant-scoped table
-- carries. `uq_work_board_columns_org_position` on `(organization_id, position)` holds the
-- one-column-per-slot invariant, so two columns cannot claim the same board slot; the service
-- resequences on read for a robust order. Writes are behind `org.manage` (org-level config); the
-- board read is behind `work.read`.
--
-- ## Identity is immutable
--
-- `organization_id` is what a row *is* — moving it to another studio is not an edit. The
-- `BEFORE UPDATE` trigger holds that at the engine, the way `work_item_recurrence` (0127) does;
-- ADR-0001 layers 3 and 4 are application-side and a direct SQL session bypasses both. The
-- column's `label`, `state_key` and `position` are otherwise mutable: a PUT rewrites them in place.

CREATE TABLE work_board_columns (
  id                CHAR(36)     NOT NULL,
  organization_id   CHAR(36)     NOT NULL,
  -- The column's display label, 1..120 chars (bounded in the service; an empty label is a 400).
  label             VARCHAR(120) NOT NULL,
  -- The work-state key this column groups. One of the work-item state machine's states; the
  -- allowlist is enforced in the service (a value off it is a 400 with no write), stored as a
  -- token so the machine's set can grow without a schema change.
  state_key         VARCHAR(40)  NOT NULL,
  -- The column's zero-based slot on the board, left to right. Unique per studio.
  position          INT          NOT NULL,
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries; also the resolve-by-id
  -- read the writes make before they authorize.
  UNIQUE KEY uq_work_board_columns_org_id (organization_id, id),
  -- One column per board slot per studio: two columns cannot claim the same position.
  UNIQUE KEY uq_work_board_columns_org_position (organization_id, position)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A board-column row's tenant is immutable, for the reason `work_item_recurrence`' trigger gives:
-- moving it to another studio would change what it is, silently.
DELIMITER $$

CREATE TRIGGER trg_work_board_columns_immutable
BEFORE UPDATE ON work_board_columns FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_board_columns.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
