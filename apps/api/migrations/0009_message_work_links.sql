-- 0009_message_work_links — the sentence "this task came from that message", made a row
-- (CHAT-003).
--
-- Governing sources: 09-MVP-PRD.md FR-02 ("Authorized user converts a message into a
-- task/request/decision. Source link is immutable; title/project/owner/date/audience are
-- confirmed. External sharing never inherits internal visibility automatically."),
-- 22-SCREEN-BY-SCREEN-SPEC.md §4 TM-06 ("create work" among the message actions),
-- 27-TEST-CATALOG.md INT-07 ("Message conversion creates one linked work item on retry"),
-- 23-ERD-AND-STATE-MACHINES.md §4 (client-generated command dedupe as the family of rule
-- this belongs to), 28-SPRINT-TICKETS §6 CHAT-003.
--
-- ## The unique key IS the idempotency
--
-- INT-07 is a property about retries, and the obvious way to buy it is `idempotency_records`
-- — a command id, a stored response, an expiry. That machinery earns its keep where the same
-- operation can legitimately happen twice with different outcomes. A message conversion is
-- not that: a message converts into **at most one** work item, ever, because the relation is
-- what the row means. So the dedupe is the relation's own unique key,
-- `(organization_id, message_id)` — the same shape as `uq_messages_client_generated`, with no
-- expiry, because "this message was already converted" does not stop being true. A retry
-- that loses the race hits the key, the transaction that would have made a second work item
-- rolls back with it, and the caller is handed the conversion that already exists.
--
-- `(organization_id, work_item_id)` is unique as well: the arrow points one way from each
-- end. A work item that could be "from" two messages would make FR-02's confirmed title and
-- date unattributable.
--
-- ## The source link is immutable, in FR-02's own words
--
-- Every column here is what the link *is*, so the trigger below refuses UPDATE wholesale.
-- `users.sql` grants the runtime credential INSERT and nothing else: re-pointing a work item
-- at a different source message, or detaching it from the conversation that explains it, is
-- not an operation this system has. A deleted work item keeps its link — the conversion
-- happened, and the row outliving the work item is the point of recording it. There is no
-- second conversion after a deletion, and that is deliberate: the message's conversion is
-- spent, and spending it again would make "one linked work item" mean "one at a time".
--
-- ## What is NOT here
--
-- No `title`, no `audience`, no confirmed fields — those land on the work item itself, which
-- already records them and audits their later changes. Duplicating them here would be two
-- copies free to disagree. And no `kind` discriminating task/request/decision: FR-02 names
-- three conversion targets, `work_items.type` already carries the vocabulary for this one,
-- and the other two convert into tables that do not exist yet (a decision has no table at
-- all; 38-COMPLETE-PRODUCT-SCOPE maps it to an unscheduled module).

CREATE TABLE message_work_links (
  id                 CHAR(36)    NOT NULL,
  organization_id    CHAR(36)    NOT NULL,
  message_id         CHAR(36)    NOT NULL,
  work_item_id       CHAR(36)    NOT NULL,
  -- Who performed the conversion. FR-02 makes it a deliberate act by an authorized user, and
  -- the work item's own audit row names the same actor; this column keeps the link legible
  -- without a join into the audit log.
  created_by_user_id CHAR(36)    NOT NULL,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_message_work_links_org_id (organization_id, id),
  -- INT-07. One conversion per message, ever. See the note above.
  UNIQUE KEY uq_message_work_links_message (organization_id, message_id),
  -- One source per work item. The arrow points one way from each end.
  UNIQUE KEY uq_message_work_links_work_item (organization_id, work_item_id),
  CONSTRAINT fk_message_work_links_message_tenant
    FOREIGN KEY (organization_id, message_id) REFERENCES messages (organization_id, id),
  CONSTRAINT fk_message_work_links_work_item_tenant
    FOREIGN KEY (organization_id, work_item_id) REFERENCES work_items (organization_id, id),
  CONSTRAINT fk_message_work_links_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

-- FR-02: "Source link is immutable." Refused wholesale rather than column by column, for the
-- reason `message_revisions`' trigger gives: there is no column on this table whose change
-- would not falsify the sentence the row exists to make.
CREATE TRIGGER trg_message_work_links_immutable
BEFORE UPDATE ON message_work_links FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'message_work_links rows are immutable';
END$$

DELIMITER ;
