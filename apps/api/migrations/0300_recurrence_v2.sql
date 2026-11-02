-- 0300_recurrence_v2 — 53-09 recurring work v2 (R17 slice e).
--
-- ## What this migration is for
--
-- `work_item_recurrence` (0127) held a cadence only (`freq`, `interval_count`, `until_at`) and nothing
-- ever created the next task. 53-09 makes the rule real: an allowlisted RRULE subset (parsed in
-- `packages/domain/src/schedule/recurrence.ts`), a holiday policy over the 53-02 working calendar,
-- "create next on schedule / when done", pause / resume / end, and an in-process spawner that
-- materialises occurrences as work items.
--
-- - `work_item_recurrence` gains the v2 rule columns. `freq/interval_count/until_at` are kept and
--   still written (the old `{freq, interval, until}` body keeps working). Closed lists — `spawn_mode`
--   ('on_schedule' | 'after_done'), `holiday_policy` ('keep' | 'skip' | 'next_working_day'), `status`
--   ('active' | 'paused' | 'ended') — are VARCHAR checked in the application, not ENUM/CHECK.
--   `starts_on` is the rule's anchor (DTSTART). `template_json` is the snapshot a spawned item is made
--   from; `owner_user_id` is whose permission spawning runs under (re-checked every spawn: a lost
--   `work.create` pauses the rule). `last_occurrence_key` is the newest spawned scheduled date.
--   A row with `rrule` NULL (every row before this migration) is inert: the spawner never reads it
--   until the rule is saved again, so nothing starts creating tasks on deploy.
-- - `work_item_recurrence_instances` (TENANT, new): one row per occurrence the series has dealt with
--   — `created` (a work item was spawned for it) or `skipped` (a member skipped it ahead of time).
--   `UNIQUE (organization_id, recurrence_id, occurrence_key)` is the idempotency key: the spawner
--   INSERTs the row first, and a duplicate key means another pass (or a pass before a restart)
--   already took that occurrence. Rows are never rewritten by "edit series": an instance is history.
--   Deleting the rule removes its instances (composite FK, ON DELETE CASCADE).
--
-- ## MariaDB-safe (live is MariaDB 11.8), as 0283
--
-- Plain columns, composite tenant keys, no generated columns, no CHECK, no JSON defaults, no
-- functional indexes, utf8mb4_unicode_ci; one ALTER with plain ADD COLUMN clauses.
--
-- ## Grants (scripts/db/users.sql, 0300 block)
--
-- `tmanage_app`: SELECT, INSERT, UPDATE, DELETE on `work_item_recurrence_instances` (the spawner runs in
-- the API process; DELETE gives a claim back when the item create failed, so the next pass retries).
-- `tmanage_worker`: nothing.

ALTER TABLE work_item_recurrence
  ADD COLUMN rrule               VARCHAR(512) NULL,
  ADD COLUMN starts_on           DATE         NULL,
  ADD COLUMN by_weekday          VARCHAR(32)  NULL,
  ADD COLUMN by_monthday         TINYINT      NULL,
  ADD COLUMN by_setpos           TINYINT      NULL,
  ADD COLUMN time_zone           VARCHAR(64)  NULL,
  ADD COLUMN spawn_mode          VARCHAR(12)  NOT NULL DEFAULT 'on_schedule',
  ADD COLUMN spawn_ahead_days    TINYINT      NOT NULL DEFAULT 1,
  ADD COLUMN holiday_policy      VARCHAR(20)  NOT NULL DEFAULT 'next_working_day',
  ADD COLUMN count_limit         SMALLINT     NULL,
  ADD COLUMN status              VARCHAR(8)   NOT NULL DEFAULT 'active',
  ADD COLUMN template_json       JSON         NULL,
  ADD COLUMN owner_user_id       CHAR(36)     NULL,
  ADD COLUMN last_occurrence_key VARCHAR(32)  NULL;

-- The spawner's per-tick read: active, materialised rules of one organization.
CREATE INDEX ix_work_item_recurrence_status ON work_item_recurrence (organization_id, status);

-- The rule owner defaults to whoever created the seed item: the actor of its `work_item.created`
-- audit row (work_items has no creator column), else the item's owner. Both reads are tenant-matched,
-- so a row can only take a person of its own organization. A rule left without an owner is inert
-- until someone saves it again (the spawner pauses a rule with no owner).
UPDATE work_item_recurrence r
   SET r.owner_user_id = (
     SELECT a.actor_user_id FROM audit_events a
      WHERE a.organization_id = r.organization_id AND a.object_id = r.work_item_id
        AND a.action = 'work_item.created' AND a.actor_user_id IS NOT NULL
      ORDER BY a.id LIMIT 1)
 WHERE r.owner_user_id IS NULL;

UPDATE work_item_recurrence r
  JOIN work_items w ON w.organization_id = r.organization_id AND w.id = r.work_item_id
   SET r.owner_user_id = w.owner_user_id
 WHERE r.owner_user_id IS NULL;

CREATE TABLE work_item_recurrence_instances (
  id                     CHAR(36)    NOT NULL,
  organization_id        CHAR(36)    NOT NULL,
  recurrence_id          CHAR(36)    NOT NULL,
  -- The scheduled local date (before the holiday policy moved it), `YYYY-MM-DD`.
  occurrence_key         VARCHAR(32) NOT NULL,
  -- The spawned item; NULL for a skipped occurrence (and for the instant between claim and create).
  work_item_id           CHAR(36)    NULL,
  -- The series' previous spawned item, so an instance links back along the chain.
  previous_work_item_id  CHAR(36)    NULL,
  -- 'created' | 'skipped' (checked in the application).
  status                 VARCHAR(8)  NOT NULL,
  created_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_wiri_org_id (organization_id, id),
  UNIQUE KEY uq_wiri_occurrence (organization_id, recurrence_id, occurrence_key),
  CONSTRAINT fk_wiri_recurrence
    FOREIGN KEY (organization_id, recurrence_id)
    REFERENCES work_item_recurrence (organization_id, id)
    ON DELETE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_wiri_org_immutable
BEFORE UPDATE ON work_item_recurrence_instances FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_recurrence_instances.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
