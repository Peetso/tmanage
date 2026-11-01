-- 0278_client_conversation_read_state — R7 fix-forward (gate2, 2026-11-01).
--
-- A client person in a group or direct conversation had no stored read marker: the read-state row
-- named `memberships (organization_id, id)`, and a client's membership is a `client_memberships`
-- row. Their conversations read as fully read and their ticks never advanced.
--
-- The row now names exactly one reader:
--
-- 1. `membership_id` becomes NULL-able (an internal member's row keeps it, as before).
-- 2. `client_membership_id` (new, NULL-able) names a client reader, bound within the tenant by
--    `fk_conversation_read_state_client_membership_tenant` to `client_memberships (organization_id,
--    id)`.
-- 3. `uq_conversation_read_state_client (organization_id, conversation_id, client_membership_id)`
--    is the client upsert key, beside `uq_conversation_read_state_member`. A NULL in either key
--    never collides, so each key only constrains its own kind of reader.
--
-- The application writes exactly one of the two ids (`ConversationReadStateRepository`, keyed by
-- the principal's kind). No CHECK constraint (the project's MariaDB rule).
--
-- Trigger: `trg_conversation_read_state_immutable` (0122) compared `membership_id` with `<>`, which
-- is never true when a side is NULL. It is re-created null-safe (`<=>`) and pins
-- `client_membership_id` too.
--
-- Grants: `tmanage_app` already holds SELECT, INSERT, UPDATE on `conversation_read_state` (0122);
-- the new column rides the table-level grant.
--
-- MariaDB 11.8 / MySQL 8 safe: plain MODIFY to NULL, ADD COLUMN, composite FK and unique key; no
-- generated column, no CHECK, no expression default.

ALTER TABLE conversation_read_state
  MODIFY membership_id CHAR(36) NULL,
  ADD COLUMN client_membership_id CHAR(36) NULL AFTER membership_id,
  ADD UNIQUE KEY uq_conversation_read_state_client
    (organization_id, conversation_id, client_membership_id),
  ADD CONSTRAINT fk_conversation_read_state_client_membership_tenant
    FOREIGN KEY (organization_id, client_membership_id)
    REFERENCES client_memberships (organization_id, id);

DROP TRIGGER IF EXISTS trg_conversation_read_state_immutable;

DELIMITER $$

CREATE TRIGGER trg_conversation_read_state_immutable
BEFORE UPDATE ON conversation_read_state FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversation_read_state.organization_id is immutable';
  END IF;
  IF NOT (NEW.conversation_id <=> OLD.conversation_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversation_read_state.conversation_id is immutable';
  END IF;
  IF NOT (NEW.membership_id <=> OLD.membership_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversation_read_state.membership_id is immutable';
  END IF;
  IF NOT (NEW.client_membership_id <=> OLD.client_membership_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversation_read_state.client_membership_id is immutable';
  END IF;
END$$

DELIMITER ;
