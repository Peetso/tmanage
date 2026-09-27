-- 0128_work_item_estimates — an effort estimate per work item (x258, Work module).
--
-- Governing sources: 38-MODULE-MAP §Work (plan/execute the same object; time), 23-ERD-AND-STATE-
-- MACHINES §2 (tenant-scoped, parent-owned records), 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- x231 (0103) records the *actual* effort spent on a work item as a list of time-log entries. This
-- is the *plan* half: a single estimate of how long the item should take, in minutes, read back
-- beside the logged actual so a planner sees estimate vs actual and the variance between them. One
-- estimate per work item — set it, revise it — so the row is upserted on `(organization_id,
-- work_item_id)`, never a growing list.
--
-- ## Parent- and tenant-scoped
--
-- An estimate belongs to one work item of one studio. `organization_id` scopes it to the tenant;
-- the composite foreign key `fk_work_item_estimates_work_item` binds `(organization_id,
-- work_item_id)` to `work_items (organization_id, id)`, so an estimate can only ever name a work
-- item of its own tenant — a cross-tenant `work_item_id` does not exist as a pair even when both
-- ids exist individually. That is the engine half of the trap the service also enforces in code: a
-- cross-tenant parent is a 404, never a write.
--
-- ## One estimate per item
--
-- `uq_work_item_estimates_org_item (organization_id, work_item_id)` is the upsert key: `INSERT ...
-- ON DUPLICATE KEY UPDATE` sets or revises the single estimate for an item, and the unique key
-- makes a second row impossible. `estimate_minutes` is `INT UNSIGNED` — the service bounds it to
-- `0 < minutes <= 100000` before the write.
--
-- ## Identity is immutable
--
-- `organization_id` and `work_item_id` are what an estimate *is*: re-parenting it or moving it to
-- another studio is not an edit. Only `estimate_minutes` (and its `updated_at`) may change. The
-- `BEFORE UPDATE` trigger holds identity at the engine — ADR-0001 layers 3 and 4 are
-- application-side and a direct SQL session bypasses both.

CREATE TABLE work_item_estimates (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  work_item_id       CHAR(36)     NOT NULL,
  -- The planned effort in minutes. The service bounds it to 0 < minutes <= 100000 before write.
  estimate_minutes   INT UNSIGNED NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_work_item_estimates_org_id (organization_id, id),
  -- One estimate per work item: the upsert key. `INSERT ... ON DUPLICATE KEY UPDATE` sets or
  -- revises the single estimate, and this key makes a second row for the same item impossible.
  UNIQUE KEY uq_work_item_estimates_org_item (organization_id, work_item_id),
  -- An estimate can only ever name a work item of its own tenant; the composite key is what makes a
  -- cross-tenant `work_item_id` a non-existent pair rather than a leak.
  CONSTRAINT fk_work_item_estimates_work_item
    FOREIGN KEY (organization_id, work_item_id) REFERENCES work_items (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An estimate's tenant and parent are immutable, for the reason the time-log trigger gives:
-- re-parenting it or moving it to another studio would change what it is, silently. Only
-- `estimate_minutes` (and its `updated_at`) is edited in place through the upsert; the trigger
-- guards a direct SQL session all the same.
DELIMITER $$

CREATE TRIGGER trg_work_item_estimates_immutable
BEFORE UPDATE ON work_item_estimates FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_estimates.organization_id is immutable';
  END IF;
  IF NEW.work_item_id <> OLD.work_item_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_estimates.work_item_id is immutable';
  END IF;
END$$

DELIMITER ;
