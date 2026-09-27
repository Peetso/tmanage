-- 0103_work_item_time_logs — logged effort per work item (x231, Work module 7).
--
-- Governing sources: 38-MODULE-MAP §Work (the audit's "Work built; no time/effort logging"),
-- 23-ERD-AND-STATE-MACHINES §2 (tenant-scoped, parent-owned records), 07-DATA-MODEL §9 (index
-- prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite
-- tenant keys).
--
-- ## What this migration is for
--
-- WORK-001 stores the work item and its detail screen; time/effort logging was never built. This
-- is that object at its smallest useful size: a labelled list of effort entries hanging off one
-- work item, each recording how many minutes were spent, by whom, on what day, with an optional
-- note. Log / list / delete-own, and a summed total per item — nothing more. Per-entry edit and a
-- rate/billing dimension are deferred (NS-13).
--
-- ## Parent- and tenant-scoped
--
-- A time-log entry belongs to one work item of one studio. `organization_id` scopes it to the
-- tenant, the way every sibling table is scoped; the composite foreign key
-- `fk_work_item_time_logs_work_item` binds `(organization_id, work_item_id)` to
-- `work_items (organization_id, id)`, so an entry can only ever name a work item of its own
-- tenant — a cross-tenant `work_item_id` does not exist as a pair even when both ids exist
-- individually. That is the engine half of the trap the service also enforces in code: a
-- cross-tenant parent is a 404, never a write.
--
-- ## `minutes`, `logged_by`, `spent_on`, `note`
--
-- `minutes` is `INT UNSIGNED` — the service bounds it to `0 < minutes <= 1440` (one day). `logged_by`
-- is the membership that recorded the entry, the anchor for the "delete only your own" rule.
-- `spent_on` is the calendar day the effort was spent, a `DATE` parsed from a bound request value —
-- never the admin-pool clock. `note` is a short optional annotation.
--
-- ## Identity is immutable
--
-- `organization_id` and `work_item_id` are what an entry *is*: moving it to another studio or
-- re-parenting it is not an edit, and there is no edit path at all this slice. The `BEFORE UPDATE`
-- trigger holds identity at the engine — ADR-0001 layers 3 and 4 are application-side and a direct
-- SQL session bypasses both.

CREATE TABLE work_item_time_logs (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  work_item_id       CHAR(36)     NOT NULL,
  -- The membership that recorded this entry — the anchor for "delete only your own".
  logged_by          CHAR(36)     NOT NULL,
  -- Effort in minutes. The service bounds it to 0 < minutes <= 1440 (one day) before insert.
  minutes            INT UNSIGNED NOT NULL,
  -- The calendar day the effort was spent, parsed from a bound request value (never the clock).
  spent_on           DATE         NOT NULL,
  -- A short optional annotation about what the time was spent on.
  note               VARCHAR(500) NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_work_item_time_logs_org_id (organization_id, id),
  -- The index the panel's list is served by: this tenant's entries for one work item, newest
  -- day first (then id). Leads with `organization_id` per `07-DATA-MODEL` §9.
  KEY ix_work_item_time_logs_item (organization_id, work_item_id, spent_on, id),
  -- An entry can only ever name a work item of its own tenant; the composite key is what makes a
  -- cross-tenant `work_item_id` a non-existent pair rather than a leak.
  CONSTRAINT fk_work_item_time_logs_work_item
    FOREIGN KEY (organization_id, work_item_id) REFERENCES work_items (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A time-log entry's tenant and parent are immutable, for the reason the checklist trigger gives:
-- re-parenting it or moving it to another studio would change what it is, silently. There is no
-- edit path this slice; the trigger guards a direct SQL session all the same.
DELIMITER $$

CREATE TRIGGER trg_work_item_time_logs_immutable
BEFORE UPDATE ON work_item_time_logs FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_time_logs.organization_id is immutable';
  END IF;
  IF NEW.work_item_id <> OLD.work_item_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_time_logs.work_item_id is immutable';
  END IF;
END$$

DELIMITER ;
