-- 0410_time_trust — time you can trust (owner rule, 2026-11-23).
--
-- ## What this migration is for
--
-- The owner: "Why does the timer let me add whatever time I want? That is a scam on the workspace
-- manager, who sees the wrong time for the employee." Time that reaches managers, HR, accountants,
-- invoices and the client portal must say which minutes were measured by the server and which were
-- typed in, and typed-in minutes count only once a manager accepts them.
--
-- `work_item_time_logs` (0103/0265) gains:
--
-- - `approval_state` VARCHAR(16) — `none` | `pending` | `approved` | `rejected`, a closed list
--   checked in `@tmanage/domain` (`time/trust.ts`). Default `none`: timer and automatic time, and
--   every entry written before this rule.
-- - `counted` TINYINT(1) — the stored answer of `entryCounts()` (one decision, AR-8): 1 when the
--   entry counts in totals, reports, invoices, payroll exports and the portal. Every reader filters
--   on it; the API rewrites it at each state change. Default 1, so a process still on the previous
--   release (RT-3 overlap, DA-6 expand) never hides real time.
-- - `reason` VARCHAR(500) — why time was added by hand or a correction was asked for.
-- - `corrects_entry_id` CHAR(36) — on a `source = 'correction'` row: the measured entry it
--   corrects. `superseded_by` CHAR(36) — on that measured entry once the correction is approved
--   (it stays visible in the history and stops counting). No foreign key (the 0257 convention: the
--   service resolves both ids tenant-scoped).
-- - `decided_by` / `decided_at` / `decision_note` — the manager's approval or refusal.
-- - `ix_witl_approval (organization_id, approval_state, spent_on, id)` — the approval queue.
--
-- One engine guard beside the 0265/0288 triggers, so a direct SQL session is held to the API's
-- rule: `trg_work_item_time_logs_measured_upd` — `source` never changes (hand time can never be
-- relabelled as timer time), and a measured row (`timer`, `automatic`) keeps its start and day,
-- never gains minutes and never ends later. Splitting measured time across tasks (shorter row +
-- a new piece) still works; raising it does not.
--
-- ## Backfill
--
-- A timer the worker stopped at the limit (`needs_review = 1`) "never silently counts": open rows
-- (not locked, not invoiced) become `counted = 0, approval_state = 'pending'` so they join the
-- manager's queue. Closed periods and invoiced time are history and stay as they were. Batched
-- (5000 rows per statement) by a temporary procedure, dropped at once (the 0265 form).
--
-- ## MariaDB-safe (live is MariaDB 11.8), expand only
--
-- Plain columns with defaults, no CHECK, no generated column, no JSON, no foreign key,
-- utf8mb4_unicode_ci; the ALTER is online (ALGORITHM=INPLACE, LOCK=NONE; DA-7); the trigger in a
-- DELIMITER $$ block as 0288. Re-run safe (DA-8): an applied ADD COLUMN or trigger is read as
-- applied by the migrator, the backfill only touches rows still matching.
--
-- ## Grants
--
-- None new: `tmanage_app` already holds SELECT, INSERT, UPDATE, DELETE on `work_item_time_logs`
-- (0103, 0288, 0290) and SELECT/INSERT on `org_settings`; `tmanage_worker` INSERT on
-- `work_item_time_logs` and SELECT on `org_settings` (scripts/db/users.sql).

ALTER TABLE work_item_time_logs
  ADD COLUMN approval_state    VARCHAR(16)  NOT NULL DEFAULT 'none' AFTER needs_review,
  ADD COLUMN counted           TINYINT(1)   NOT NULL DEFAULT 1 AFTER approval_state,
  ADD COLUMN reason            VARCHAR(500) NULL AFTER counted,
  ADD COLUMN corrects_entry_id CHAR(36)     NULL AFTER reason,
  ADD COLUMN superseded_by     CHAR(36)     NULL AFTER corrects_entry_id,
  ADD COLUMN decided_by        CHAR(36)     NULL AFTER superseded_by,
  ADD COLUMN decided_at        DATETIME(3)  NULL AFTER decided_by,
  ADD COLUMN decision_note     VARCHAR(500) NULL AFTER decided_at,
  ADD KEY ix_witl_approval (organization_id, approval_state, spent_on, id),
  ALGORITHM=INPLACE, LOCK=NONE;

DELIMITER $$

CREATE TRIGGER trg_work_item_time_logs_measured_upd
BEFORE UPDATE ON work_item_time_logs FOR EACH ROW
BEGIN
  IF NOT (NEW.source <=> OLD.source) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_time_logs.source is immutable';
  END IF;
  IF OLD.source IN ('timer', 'automatic') AND (
       NOT (NEW.started_at <=> OLD.started_at)
       OR NOT (NEW.spent_on <=> OLD.spent_on)
       OR NEW.minutes > OLD.minutes
       OR (OLD.ended_at IS NOT NULL AND (NEW.ended_at IS NULL OR NEW.ended_at > OLD.ended_at))) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_time_logs measured time cannot be raised or moved';
  END IF;
END$$

DROP PROCEDURE IF EXISTS tmp_0410_backfill_capped_timers$$

CREATE PROCEDURE tmp_0410_backfill_capped_timers()
BEGIN
  DECLARE touched INT DEFAULT 1;
  WHILE touched > 0 DO
    UPDATE work_item_time_logs
       SET counted = 0, approval_state = 'pending'
     WHERE source = 'timer'
       AND needs_review = 1
       AND approval_state = 'none'
       AND locked_at IS NULL
       AND invoice_line_id IS NULL
     LIMIT 5000;
    SET touched = ROW_COUNT();
  END WHILE;
END$$

DELIMITER ;

CALL tmp_0410_backfill_capped_timers();

DROP PROCEDURE IF EXISTS tmp_0410_backfill_capped_timers;
