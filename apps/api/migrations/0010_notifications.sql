-- 0010_notifications — the row that tells one person one thing happened (NOTIF-001).
--
-- Governing sources: contracts/tmanage-core.dbml (the table, verbatim — columns, the unique
-- dedupe key, the recipient/time index), 24-EVENT-CATALOG.md §4 (client_request.submitted
-- and .transitioned name "notification" among their primary consumers) and §6 ("Consumers
-- cannot infer authorization from event receipt; before user-facing side effects they
-- resolve current permissions. Delayed notifications must not reveal an object after access
-- was revoked."), 13-ENGINEERING-EXECUTION-SPEC.md §5 (notifications is in the
-- vertical-slice schema), 28-SPRINT-TICKETS §6 NOTIF-001.
--
-- ## The dedupe key IS the bundle foundation
--
-- `(organization_id, recipient_user_id, dedupe_key)` is unique, and the writer treats a
-- collision as success — the same INT-07 stance as `message_work_links`, for the same
-- reason: the relay delivers at-least-once, so the consumer that writes these rows will
-- run twice for one fact, and "this person was already told this" does not stop being
-- true. The key is also where bundling starts: a bundler is a *policy about keys* — widen
-- the key, and five comments become one row — which is why the column exists now, before
-- any bundler does.
--
-- ## What a notification carries: a reference, never content
--
-- Type, object type, object id. No title, no body, no excerpt — the same rule as
-- `outbox_events.payload_json` and §12's audit metadata, and with more force here: a
-- notification outlives the access decision that allowed it, so any content it carried
-- would be readable after access was revoked. A reader resolves the object through the
-- ordinary authorized read path at display time, and a reference to a row they may no
-- longer see resolves to nothing.
--
-- ## What may change after the write: read_at, and nothing else
--
-- A notification is a fact about a moment. The trigger below refuses every column change
-- except `read_at` moving from NULL to a time — marking read is the one verb the row has.
-- Un-reading is refused too: "was this person told" is the question the row answers, and a
-- read that could be unread makes the answer mutable.

CREATE TABLE notifications (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  recipient_user_id  CHAR(36)     NOT NULL,
  -- The outbox event type that caused it, e.g. `client_request.transitioned.v1`. A closed
  -- vocabulary by construction rather than by CHECK: only the worker's consumers write
  -- rows, and each writes the type it answers to.
  type               VARCHAR(190) NOT NULL,
  object_type        VARCHAR(64)  NOT NULL,
  object_id          CHAR(36)     NOT NULL,
  dedupe_key         VARCHAR(190) NOT NULL,
  read_at            DATETIME(3)  NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_notifications_org_id (organization_id, id),
  -- The contract's own two indexes: the inbox read, and the dedupe.
  KEY ix_notifications_recipient_time (organization_id, recipient_user_id, created_at),
  UNIQUE KEY uq_notifications_dedupe (organization_id, recipient_user_id, dedupe_key),
  CONSTRAINT fk_notifications_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The recipient is a user, not a membership: identity is global, and the row must
  -- survive a membership being revoked — §6's rule is enforced at *display* time by the
  -- read path, not by cascading history away.
  CONSTRAINT fk_notifications_recipient
    FOREIGN KEY (recipient_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_notifications_read_only_forward
BEFORE UPDATE ON notifications FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.recipient_user_id <> OLD.recipient_user_id
     OR NEW.type <> OLD.type
     OR NEW.object_type <> OLD.object_type
     OR NEW.object_id <> OLD.object_id
     OR NEW.dedupe_key <> OLD.dedupe_key
     OR NEW.created_at <> OLD.created_at THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'notifications: only read_at may change';
  END IF;
  IF OLD.read_at IS NOT NULL AND (NEW.read_at IS NULL OR NEW.read_at <> OLD.read_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'notifications: read_at cannot be cleared or rewritten';
  END IF;
END$$

DELIMITER ;
