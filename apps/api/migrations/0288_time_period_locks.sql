-- 0288_time_period_locks — 52-03 period locks, the lock half (R15 slice b).
--
-- ## What this migration is for
--
-- Finance closes a month: every time entry filed in it stops changing, so the invoice, the payroll
-- export and the budget report all read the same minutes. `work_item_time_logs.locked_at` (0265)
-- already marks a locked entry and the 0265 trigger already refuses edits of one; nothing set it.
--
-- - `time_period_locks` (TENANT, new) — one closed window of whole calendar months. `locked_by` /
--   `locked_at` stamp who closed it; `unlocked_by` / `unlocked_at` / `reason` stamp who reopened it
--   and why (a reopened row stays as history). `entries_locked` is how many entries the lock
--   stamped. One row per organization per `period_start` (a relock of the same month reopens that
--   row); the application refuses a window that overlaps another open lock.
-- - Two engine guards on `work_item_time_logs`, beside the 0265 trigger (a direct SQL session is
--   held to the same rule as the API):
--   - `trg_work_item_time_logs_locked_upd` — a locked row that stays locked may not change any data
--     column of 0265. The unlock write (`locked_at` back to NULL) and the lock stamp on an unlocked
--     row are the only changes the period lock lets through.
--   - `trg_work_item_time_logs_locked_del` — a locked row is never deleted.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATE / DATETIME(3), composite tenant keys, no generated columns, no CHECK, no JSON,
-- no functional indexes, utf8mb4_unicode_ci; triggers in DELIMITER $$ blocks as 0283. MariaDB and
-- MySQL 8 both allow a second BEFORE UPDATE trigger on a table; it runs after the 0265 one.
--
-- ## Grants (scripts/db/users.sql, 0288 block)
--
-- `tmanage_app`: SELECT, INSERT, UPDATE on `time_period_locks` (no DELETE: a lock row is history);
-- UPDATE on
-- `work_item_time_logs` (the lock stamp and the unlock write — the first UPDATE statement on that
-- table). `tmanage_worker`: nothing.

CREATE TABLE time_period_locks (
  id               CHAR(36)      NOT NULL,
  organization_id  CHAR(36)      NOT NULL,
  -- The first day of the first month in the window.
  period_start     DATE          NOT NULL,
  -- The last day of the last month in the window (inclusive).
  period_end       DATE          NOT NULL,
  -- The membership that closed the window.
  locked_by        CHAR(36)      NOT NULL,
  locked_at        DATETIME(3)   NOT NULL,
  -- The membership that reopened it; NULL while the lock is open.
  unlocked_by      CHAR(36)      NULL,
  unlocked_at      DATETIME(3)   NULL,
  -- Why it was reopened (3..500 characters, checked in the application).
  reason           VARCHAR(500)  NULL,
  entries_locked   INT           NOT NULL DEFAULT 0,
  created_at       DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_time_period_locks_org_id (organization_id, id),
  UNIQUE KEY uq_time_period_locks_start (organization_id, period_start),
  KEY ix_time_period_locks_end (organization_id, period_end),
  CONSTRAINT fk_time_period_locks_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

-- organization_id is immutable (ADR-0001 layer 1), as on every tenant table.
CREATE TRIGGER trg_time_period_locks_org_immutable
BEFORE UPDATE ON time_period_locks FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'time_period_locks.organization_id is immutable';
  END IF;
END$$

-- A locked entry that stays locked keeps every 0265 data column. Only these columns are named:
-- later columns (rate snapshots and the like) are guarded by the slices that add them.
CREATE TRIGGER trg_work_item_time_logs_locked_upd
BEFORE UPDATE ON work_item_time_logs FOR EACH ROW
BEGIN
  IF OLD.locked_at IS NOT NULL AND NEW.locked_at IS NOT NULL AND (
       NOT (NEW.work_item_id <=> OLD.work_item_id)
       OR NOT (NEW.project_id <=> OLD.project_id)
       OR NOT (NEW.logged_by <=> OLD.logged_by)
       OR NOT (NEW.minutes <=> OLD.minutes)
       OR NOT (NEW.spent_on <=> OLD.spent_on)
       OR NOT (NEW.started_at <=> OLD.started_at)
       OR NOT (NEW.ended_at <=> OLD.ended_at)
       OR NOT (NEW.billable <=> OLD.billable)
       OR NOT (NEW.note <=> OLD.note)) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_time_logs row is locked';
  END IF;
END$$

CREATE TRIGGER trg_work_item_time_logs_locked_del
BEFORE DELETE ON work_item_time_logs FOR EACH ROW
BEGIN
  IF OLD.locked_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_time_logs row is locked';
  END IF;
END$$

DELIMITER ;
