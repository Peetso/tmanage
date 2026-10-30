-- 0265_time_timers — the running timer and richer time entries (52-01 backend half; spec 52 §52-01).
--
-- ## What this migration is for
--
-- A member starts a timer, works, stops it, and one time entry is written with when it started and
-- ended. Two changes:
--
-- - `time_timers` (TENANT, new) — the one running timer of one membership. `UNIQUE (organization_id,
--   membership_id)` is the one-timer invariant at the engine: a second start without `force` is a
--   409, and a race between two starts loses on the duplicate key. `started_at` is the server's
--   clock, never a client value. `last_heartbeat_at` is moved by the heartbeat route (throttled by
--   the 56-05 limiter). `user_id` is kept so the worker's auto-stop can name the person in the audit
--   row without reading `memberships`. The row is deleted when the timer stops; nothing else lives
--   here.
-- - `work_item_time_logs` (0103) gains `started_at`, `ended_at`, `billable`, `source`
--   (`manual` | `timer`, closed list checked in the application), `needs_review` (set by the
--   auto-stop), `project_id` (backfilled from the work item), `updated_at`, `updated_by`,
--   `locked_at` and `timesheet_id` (later slices fill the last two: 52-02 timesheets, 52-03 locks).
--   `work_item_id` becomes NULL-able: a timer started on a project, not an item, lands in the
--   project's "unsorted" bucket. Rate/cost snapshots and `invoice_line_id` are NOT added here
--   (52-04 / 52-09).
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, closed lists checked in the application, DATETIME(3), no generated columns, no
-- CHECK, no JSON defaults, no functional indexes, utf8mb4_unicode_ci. `time_timers` carries no
-- foreign key (the 0257 convention): the service resolves the work item and project tenant-scoped
-- before it writes, and a purged work item must not be blocked by somebody's running timer (the
-- stop path then files the entry without the item). The 0103 composite foreign key on
-- `work_item_time_logs.work_item_id` stays; a NULL `work_item_id` simply has no parent to check.
--
-- ## Org settings
--
-- `org_policies.policy_json` (0072) may carry `time_autostop_hours` (4..24, default 12) and
-- `time_presence_visible` (default false). No column and no new table: absent keys read as the
-- defaults in `modules/time/time-rules.ts` and in the worker's `timer-autostop.ts`.

CREATE TABLE time_timers (
  id                CHAR(36)     NOT NULL,
  organization_id   CHAR(36)     NOT NULL,
  -- The membership the timer belongs to. One running timer per membership (uq below).
  membership_id     CHAR(36)     NOT NULL,
  -- The person behind the membership, for the worker's audit row.
  user_id           CHAR(36)     NOT NULL,
  -- What the time is for: a work item (its project is copied) or only a project. Both NULL is
  -- allowed: the entry is filed unsorted.
  work_item_id      CHAR(36)     NULL,
  project_id        CHAR(36)     NULL,
  note              VARCHAR(500) NULL,
  billable          TINYINT(1)   NOT NULL DEFAULT 1,
  -- Server clock at start. Never a client value.
  started_at        DATETIME(3)  NOT NULL,
  last_heartbeat_at DATETIME(3)  NOT NULL,
  created_at        DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_time_timers_org_id (organization_id, id),
  -- The one-timer invariant.
  UNIQUE KEY uq_time_timers_org_member (organization_id, membership_id),
  -- Presence ("who is tracking on this project").
  KEY ix_time_timers_org_project (organization_id, project_id),
  -- The worker's cross-tenant auto-stop sweep: oldest timers first.
  KEY ix_time_timers_started (started_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE work_item_time_logs
  MODIFY COLUMN work_item_id CHAR(36) NULL,
  ADD COLUMN project_id   CHAR(36)    NULL AFTER work_item_id,
  ADD COLUMN started_at   DATETIME(3) NULL AFTER spent_on,
  ADD COLUMN ended_at     DATETIME(3) NULL AFTER started_at,
  ADD COLUMN billable     TINYINT(1)  NOT NULL DEFAULT 1 AFTER ended_at,
  -- `manual` (typed in) or `timer` (stopped timer or worker auto-stop). Checked in the application.
  ADD COLUMN source       VARCHAR(16) NOT NULL DEFAULT 'manual' AFTER billable,
  -- 1 when the worker stopped a forgotten timer: the person should look at the entry.
  ADD COLUMN needs_review TINYINT(1)  NOT NULL DEFAULT 0 AFTER source,
  ADD COLUMN updated_at   DATETIME(3) NULL AFTER created_at,
  ADD COLUMN updated_by   CHAR(36)    NULL AFTER updated_at,
  -- Set by 52-03 (period locks); a locked entry refuses every edit (trigger below).
  ADD COLUMN locked_at    DATETIME(3) NULL AFTER updated_by,
  -- Set by 52-02 (timesheets).
  ADD COLUMN timesheet_id CHAR(36)    NULL AFTER locked_at,
  ADD KEY ix_witl_member_day (organization_id, logged_by, spent_on, id),
  ADD KEY ix_witl_project_day (organization_id, project_id, spent_on, id);

-- Replace the 0103 trigger. Identity still holds: the tenant and the author never move, and a work
-- item, once named, never changes (an unsorted entry may be filed under an item once). A locked
-- entry refuses every edit; the one update allowed on it is clearing `locked_at` alone (the 52-03
-- unlock), with every data column left as it was.
DROP TRIGGER IF EXISTS trg_work_item_time_logs_immutable;

DELIMITER $$

CREATE TRIGGER trg_work_item_time_logs_immutable
BEFORE UPDATE ON work_item_time_logs FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_time_logs.organization_id is immutable';
  END IF;
  IF NEW.logged_by <> OLD.logged_by THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_time_logs.logged_by is immutable';
  END IF;
  IF OLD.work_item_id IS NOT NULL AND NOT (NEW.work_item_id <=> OLD.work_item_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_time_logs.work_item_id is immutable';
  END IF;
  IF OLD.locked_at IS NOT NULL THEN
    IF NEW.locked_at IS NOT NULL
       OR NEW.minutes <> OLD.minutes
       OR NEW.spent_on <> OLD.spent_on
       OR NOT (NEW.started_at <=> OLD.started_at)
       OR NOT (NEW.ended_at <=> OLD.ended_at)
       OR NEW.billable <> OLD.billable
       OR NOT (NEW.note <=> OLD.note)
       OR NOT (NEW.work_item_id <=> OLD.work_item_id)
       OR NOT (NEW.project_id <=> OLD.project_id)
       OR NOT (NEW.timesheet_id <=> OLD.timesheet_id) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'work_item_time_logs row is locked';
    END IF;
  END IF;
END$$

-- Batched backfill of `project_id` from the parent work item, at most 5000 rows per statement so
-- no single statement holds a long lock on a large table. A temporary procedure, dropped at once.
DROP PROCEDURE IF EXISTS tmp_0265_backfill_time_log_projects$$

CREATE PROCEDURE tmp_0265_backfill_time_log_projects()
BEGIN
  DECLARE touched INT DEFAULT 1;
  WHILE touched > 0 DO
    UPDATE work_item_time_logs l
       SET l.project_id = (
             SELECT w.project_id FROM work_items w
              WHERE w.organization_id = l.organization_id AND w.id = l.work_item_id)
     WHERE l.project_id IS NULL
       AND l.work_item_id IS NOT NULL
       AND EXISTS (
             SELECT 1 FROM work_items w2
              WHERE w2.organization_id = l.organization_id AND w2.id = l.work_item_id
                AND w2.project_id IS NOT NULL)
     LIMIT 5000;
    SET touched = ROW_COUNT();
  END WHILE;
END$$

DELIMITER ;

CALL tmp_0265_backfill_time_log_projects();

DROP PROCEDURE IF EXISTS tmp_0265_backfill_time_log_projects;
