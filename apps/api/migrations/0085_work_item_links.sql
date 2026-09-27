-- 0085_work_item_links — typed links between work items (x204, Work module 7).
--
-- Governing sources: 38-MODULE-MAP §Work management (the audit's "Work built; no dependency
-- model between items"), 23-ERD-AND-STATE-MACHINES §2 (tenant-scoped, parent-owned edges),
-- 07-DATA-MODEL §9 (index prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- `0011_work_dependencies_blockers.sql` gave WORK-003 a single-purpose `depends_on` edge and a
-- blocker ledger. x204 adds the general, user-facing relationship the detail screen needs: a
-- **typed** link from one work item to another — `blocks`, `blocked_by`, or `relates` — that a
-- member can add, list and remove. It is a distinct table from `work_item_dependencies` on
-- purpose: that edge feeds the "on track" health roll-up and is immutable/delete-and-add for
-- planning integrity, while this is the human-authored graph shown on the item, carrying a type
-- the dependency edge does not have.
--
-- ## Parent- and tenant-scoped, both ends
--
-- A link belongs to one studio and names two of its work items. `organization_id` scopes it to
-- the tenant; the composite foreign keys bind BOTH `(organization_id, from_work_item_id)` and
-- `(organization_id, to_work_item_id)` to `work_items (organization_id, id)`, so a link can only
-- ever join two items of its own tenant — a cross-tenant `to_work_item_id` is a non-existent pair
-- even when both ids exist individually. That is the engine half of the trap the service also
-- enforces: both ends are resolved tenant-scoped before any write, and a cross-tenant end is a
-- 404 (never a leak, never a foreign-key 500).
--
-- ## One edge per typed pair; no self-link; immutable
--
-- `uq_work_item_links_edge` admits at most one row per `(organization_id, from, to, link_type)`,
-- so a duplicate is refused at the engine (the service refuses it first with a 400). The
-- `BEFORE INSERT` trigger refuses a self-link (`from = to`). A link has no editable field — a
-- typed edge is a fact; correcting one is delete-and-add — so the `BEFORE UPDATE` trigger refuses
-- UPDATE wholesale, `work_item_dependencies`' reasoning. Cycles across `blocks`/`blocked_by` span
-- more than one row and cannot be seen from a trigger; the service refuses them with a walk before
-- inserting, and this table is the floor under it.

CREATE TABLE work_item_links (
  id                  CHAR(36)    NOT NULL,
  organization_id     CHAR(36)    NOT NULL,
  -- The item the link is authored on (the path item). The "source" of the typed relation.
  from_work_item_id   CHAR(36)    NOT NULL,
  -- The item it points at.
  to_work_item_id     CHAR(36)    NOT NULL,
  -- blocks: from blocks to. blocked_by: from is blocked by to. relates: an undirected association.
  link_type           ENUM('blocks', 'blocked_by', 'relates') NOT NULL,
  created_by_user_id  CHAR(36)    NOT NULL,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_work_item_links_org_id (organization_id, id),
  -- One link per typed ordered pair; a duplicate is refused at the engine.
  UNIQUE KEY uq_work_item_links_edge
    (organization_id, from_work_item_id, to_work_item_id, link_type),
  -- The panel's read: this tenant's links authored on one item, oldest first.
  KEY ix_work_item_links_from (organization_id, from_work_item_id, created_at, id),
  -- The reverse read: links pointing at one item (impact).
  KEY ix_work_item_links_to (organization_id, to_work_item_id),
  -- Both ends can only ever name a work item of this link's own tenant.
  CONSTRAINT fk_work_item_links_from
    FOREIGN KEY (organization_id, from_work_item_id) REFERENCES work_items (organization_id, id),
  CONSTRAINT fk_work_item_links_to
    FOREIGN KEY (organization_id, to_work_item_id) REFERENCES work_items (organization_id, id),
  CONSTRAINT fk_work_item_links_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

-- A self-link is not a relationship. Refused at the engine, and by the service first.
CREATE TRIGGER trg_work_item_links_no_self
BEFORE INSERT ON work_item_links FOR EACH ROW
BEGIN
  IF NEW.from_work_item_id = NEW.to_work_item_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'a work item cannot link to itself';
  END IF;
END$$

-- A typed edge is a fact with no editable field: correcting one is delete-and-add. UPDATE is
-- refused wholesale, so re-pointing or re-typing a link silently is impossible.
CREATE TRIGGER trg_work_item_links_immutable
BEFORE UPDATE ON work_item_links FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'work_item_links rows are immutable: correct a link by delete and add';
END$$

DELIMITER ;
