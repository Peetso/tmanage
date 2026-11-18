-- 0378_account_erasure_log_triggers — the two append-only identity logs let the account erasure
-- do what the data inventory says, and nothing more.
--
-- ## What this migration is for
--
-- `AccountErasure` (56-18, `apps/api/src/modules/privacy/privacy-erasure.repository.ts`) runs a
-- day after an executed account deletion, once the person belongs to no organization. Per
-- `docs/security/data-inventory.md` it deletes the person's sessions (`delete`) and pseudonymises
-- their sign-in log (`pseudonymise`: the rows stay, `ip`, `user_agent` and `client_hints` are
-- nulled). Two triggers written before that rule existed refused both on every server, whatever
-- the credential (found by the ACCOUNTFIX lane, 2026-11-18):
--
-- - `trg_session_refresh_tokens_no_delete` (0003): the superseded-token ledger refuses every
--   DELETE, and its foreign key to `sessions` then holds every session of the person.
-- - `trg_authentication_events_no_update` (0004): the sign-in log refuses every UPDATE.
--
-- Each refused with SQLSTATE 45000, the erasure's one transaction rolled back, and the request
-- waited for the next pass forever.
--
-- ## The narrowed rules
--
-- Both triggers are replaced, with the same messages, by ones that allow exactly the erasure's
-- step and only for an **erased account**: `users.disabled_at` set and `users.email` equal to
-- `erased-<id>@erased.invalid` (`erasedEmail()`; the erasure pseudonymises the account first, in
-- the same transaction). Everything else stays refused, for every credential:
--
-- - `session_refresh_tokens`: a row may be deleted only when its session belongs to an erased
--   account. UPDATE stays refused without exception (`trg_session_refresh_tokens_no_update`
--   is untouched).
-- - `authentication_events`: an UPDATE may only set `ip`, `user_agent` and `client_hints` to
--   NULL, on a row of an erased account; every other column must keep its value. A new column
--   on this table must be added to the comparison below (`privacy-account-erasure.test.ts`
--   fails until it is). DELETE stays refused without exception (`..._no_delete` untouched).
--
-- `audit_events` and its hash chain are not touched: the trail is kept as written and leaves only
-- with the retention purge (data inventory, `audit_events`).
--
-- ## Safety
--
-- Trigger replacement only; no data changes. A trigger runs as its definer (the migrator), so
-- the reads of `sessions` and `users` need no grant on the caller's credential. Between the DROP
-- and the CREATE of one trigger the table is briefly unguarded by it; the runtime credential
-- holds neither UPDATE nor DELETE on either table, so the privilege layer still refuses.

DROP TRIGGER IF EXISTS trg_session_refresh_tokens_no_delete;
DROP TRIGGER IF EXISTS trg_authentication_events_no_update;

DELIMITER $$

CREATE TRIGGER trg_session_refresh_tokens_no_delete
BEFORE DELETE ON session_refresh_tokens FOR EACH ROW
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.id = OLD.session_id
       AND u.disabled_at IS NOT NULL
       AND u.email = CONCAT('erased-', u.id, '@erased.invalid')
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'session_refresh_tokens is append-only: rows cannot be deleted';
  END IF;
END$$

CREATE TRIGGER trg_authentication_events_no_update
BEFORE UPDATE ON authentication_events FOR EACH ROW
BEGIN
  IF NOT (
        NEW.id <=> OLD.id
    AND NEW.user_id <=> OLD.user_id
    AND NEW.action <=> OLD.action
    AND NEW.outcome <=> OLD.outcome
    AND NEW.reason <=> OLD.reason
    AND NEW.correlation_id <=> OLD.correlation_id
    AND NEW.occurred_at <=> OLD.occurred_at
    AND NEW.automation_score <=> OLD.automation_score
    AND NEW.automation_reasons_json <=> OLD.automation_reasons_json
    AND NEW.ip IS NULL
    AND NEW.user_agent IS NULL
    AND NEW.client_hints IS NULL
    AND EXISTS (
      SELECT 1
        FROM users u
       WHERE u.id = OLD.user_id
         AND u.disabled_at IS NOT NULL
         AND u.email = CONCAT('erased-', u.id, '@erased.invalid')
    )
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'authentication_events is append-only: a sign-in attempt is evidence';
  END IF;
END$$

DELIMITER ;
