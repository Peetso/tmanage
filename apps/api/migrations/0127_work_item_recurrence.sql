-- 0127_work_item_recurrence — a work item's recurrence rule (x257, Work module 7).
--
-- Governing sources: 38-MODULE-MAP §Work (repeatable work — the audit's "Work built; no
-- recurrence rule"), 23-ERD-AND-STATE-MACHINES §2 (tenant-scoped, parent-owned records),
-- 07-DATA-MODEL §9 (index prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- A work item may repeat on a simple cadence. This is that rule at its smallest useful size: one
-- recurrence rule per work item — a frequency (`daily`/`weekly`/`monthly`), an interval, and an
-- optional bound date after which it stops. The *next occurrence* is computed in-app on demand
-- from this rule over a bound clock; no worker or cron generates anything here, and this slice
-- writes no new work item — creating the next item stays in `work.service` (a later, Needs-Peter
-- path). Only the rule lives in this table.
--
-- ## One rule per item, parent- and tenant-scoped
--
-- A recurrence belongs to one work item of one studio. `organization_id` scopes it the way every
-- sibling table is scoped; the composite foreign key `fk_work_item_recurrence_work_item` binds
-- `(organization_id, work_item_id)` to `work_items (organization_id, id)`, so a cross-tenant
-- `work_item_id` is a non-existent pair rather than a leak even when both ids exist individually.
-- That is the engine half of the trap the service also enforces in code: a cross-tenant parent is
-- a 404, never a write. `uq_work_item_recurrence_item` on `(organization_id, work_item_id)` holds
-- the one-rule-per-item invariant, so a PUT upserts the single row rather than duplicating it.
--
-- ## Identity is immutable
--
-- `organization_id` is what a row *is* — moving it to another studio is not an edit. The
-- `BEFORE UPDATE` trigger holds that at the engine, the way `work_item_labels` (0105) does;
-- ADR-0001 layers 3 and 4 are application-side and a direct SQL session bypasses both. The rule's
-- fields are otherwise mutable: a PUT rewrites `freq`/`interval_count`/`until_at` in place.

CREATE TABLE work_item_recurrence (
  id                CHAR(36)    NOT NULL,
  organization_id   CHAR(36)    NOT NULL,
  work_item_id      CHAR(36)    NOT NULL,
  -- The cadence: one of `daily`, `weekly`, `monthly`. The allowlist is enforced in the service
  -- (a value off it is a 400 with no write); stored as a token so the set can grow without a
  -- schema change.
  freq              VARCHAR(20) NOT NULL,
  -- How many `freq` units between occurrences, 1..365 (bounded in the service). Named
  -- `interval_count` because `INTERVAL` is a reserved word in MySQL; mapped to `interval` on the
  -- wire projection.
  interval_count    INT         NOT NULL,
  -- Optional bound: the rule stops producing occurrences strictly after this instant. NULL means
  -- the rule is open-ended.
  until_at          DATETIME(3) NULL,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_work_item_recurrence_org_id (organization_id, id),
  -- One recurrence rule per work item: the key that makes a PUT an upsert rather than a duplicate,
  -- and also serves the "does this item recur?" read. Leads with `organization_id` per
  -- `07-DATA-MODEL` §9.
  UNIQUE KEY uq_work_item_recurrence_item (organization_id, work_item_id),
  -- A rule can only ever name a work item of its own tenant; the composite key is what makes a
  -- cross-tenant `work_item_id` a non-existent pair rather than a leak.
  CONSTRAINT fk_work_item_recurrence_work_item
    FOREIGN KEY (organization_id, work_item_id) REFERENCES work_items (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A recurrence row's tenant is immutable, for the reason `work_item_labels`' trigger gives:
-- moving it to another studio would change what it is, silently.
DELIMITER $$

CREATE TRIGGER trg_work_item_recurrence_immutable
BEFORE UPDATE ON work_item_recurrence FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_recurrence.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
