-- 0358_audit_retention_purge — the audit-log purge becomes real, inside the retention window only
-- (56-18 follow-up, SOC 2 C1.2, GDPR Art. 5(1)(e)).
--
-- ## What this migration is for
--
-- Until now `trg_audit_events_no_delete` (0002) refused every DELETE on `audit_events`, so the
-- stored retention window (`audit_retention_policy`, 0148) could only be previewed. This replaces
-- that trigger with one that still refuses every DELETE **except** a row that is older than its
-- own organization's explicitly stored retention window:
--
-- - no `audit_retention_policy` row for the organization  -> refused (nothing is ever deleted for a
--   workspace that never set a window);
-- - `retention_days` below the floor of 1 day (the 0148 / service bound) -> refused;
-- - `OLD.created_at` not older than `now - retention_days` -> refused.
--
-- The check reads the row's own `organization_id`, so a DELETE can never reach past one
-- organization's window into another's, whatever the statement says. The UPDATE trigger is not
-- touched: an audit row is still never edited.
--
-- `audit_event_changes` (0241, the field diffs of an audit row) gets the same guard through its
-- parent: a diff may go only when its audit row may go. It had no delete trigger before.
--
-- `audit_heads` gains the purge boundary: the last purged position of the chain and that row's
-- hash, written in the same transaction as the DELETE, so the read-only verifier (56-11) starts
-- the walk after the boundary and checks the first kept row's `prev_hash` against the stored hash
-- instead of reporting the purged prefix as `missing_row`.
--
-- ## Grants
--
-- Unchanged. `tmanage_app` still holds no DELETE on `audit_events` or `audit_event_changes`
-- (scripts/db/users.sql), so on a deployment with split users the purge reports `not_permitted`
-- and deletes nothing, like the company erasure. The single Hostinger user runs it; the trigger
-- above is what holds it to the window there.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain nullable columns, no generated columns, no CHECK, no JSON defaults, no functional
-- indexes; triggers in the 0002 / 0301 style.

ALTER TABLE audit_heads
  ADD COLUMN purged_through_seq  BIGINT      NULL,
  ADD COLUMN purged_through_hash CHAR(64)    NULL,
  ADD COLUMN purged_at           DATETIME(3) NULL;

DROP TRIGGER IF EXISTS trg_audit_events_no_delete;
DROP TRIGGER IF EXISTS trg_audit_event_changes_retention_delete;

DELIMITER $$

CREATE TRIGGER trg_audit_events_no_delete
BEFORE DELETE ON audit_events FOR EACH ROW
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audit_retention_policy p
     WHERE p.organization_id = OLD.organization_id
       AND p.retention_days >= 1
       AND OLD.created_at < CURRENT_TIMESTAMP(3) - INTERVAL p.retention_days DAY
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'audit_events is append-only: only rows past the retention window may be purged';
  END IF;
END$$

CREATE TRIGGER trg_audit_event_changes_retention_delete
BEFORE DELETE ON audit_event_changes FOR EACH ROW
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audit_events e
      JOIN audit_retention_policy p ON p.organization_id = e.organization_id
     WHERE e.organization_id = OLD.organization_id
       AND e.id = OLD.audit_event_id
       AND p.retention_days >= 1
       AND e.created_at < CURRENT_TIMESTAMP(3) - INTERVAL p.retention_days DAY
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'audit_event_changes: only diffs of rows past the retention window may be purged';
  END IF;
END$$

DELIMITER ;
