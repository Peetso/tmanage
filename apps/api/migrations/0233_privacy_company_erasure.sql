-- 0233_privacy_company_erasure — the erasure that follows a company deletion (lane H3, audit gap 3,
-- NFR-09 / 33-LEGAL §8 "export/correct/delete/anonymize → propagate → verify → respond → audit").
--
-- 0231's privacy job closes a company once its 30-day grace period ends (archived + suspended). This
-- migration adds what the erasure after that needs:
--
-- 1. `privacy_deletion_requests.purged_at` — set when the privacy job has erased every row and every
--    stored file the closed company owned. NULL on an executed company deletion means "erasure still
--    to do"; the job finds those, works in batches, and sets it once nothing is left. Idempotent: a
--    pass that stops halfway is finished by the next one.
--
-- 2. `portal_access_log`'s delete trigger is narrowed. 0109 refused every DELETE, but the log keys to
--    `projects` and `client_memberships`, so a refused log row would keep every project (and all work
--    under it) of an erased company forever. The new trigger still refuses a DELETE for every live
--    company; it allows one only when the row's company has an executed company deletion and is
--    archived — the one case where the rows must go. The UPDATE trigger is untouched.
--
-- `audit_events` stays append-only and is kept (33-LEGAL §7: audit/security events are retained), as
-- are the two privacy tables (the record of who asked for what) and the organization row itself.
--
-- MariaDB-safe: one plain nullable column, a DROP/CREATE of one trigger, no CHECK, no generated column.

ALTER TABLE privacy_deletion_requests
  ADD COLUMN purged_at DATETIME(3) NULL AFTER executed_at;

DROP TRIGGER IF EXISTS trg_portal_access_log_no_delete;

DELIMITER $$

CREATE TRIGGER trg_portal_access_log_no_delete
BEFORE DELETE ON portal_access_log FOR EACH ROW
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM privacy_deletion_requests d
      JOIN organizations o ON o.id = d.organization_id
     WHERE d.organization_id = OLD.organization_id
       AND d.kind = 'company'
       AND d.status = 'executed'
       AND o.archived_at IS NOT NULL
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'portal_access_log rows are append-only';
  END IF;
END$$

DELIMITER ;
