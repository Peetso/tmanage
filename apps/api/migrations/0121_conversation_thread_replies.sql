-- 0121_conversation_thread_replies — "someone replied in this message's thread", made a row
-- (x249, planning ref CH-05 "Thread"; module map §Chat "threads").
--
-- ## What this is, and what it is not
--
-- CHAT-001 already carries a thread shape on `messages` itself: a reply is a message with a
-- `parent_message_id`, numbered into the channel's own sequence, and `messages.depth` keeps a
-- reply from being replied to. That is the transcript's own threading. This table is the
-- lighter, append-only surface x249 asks for: a reply *to a message's thread* that never
-- enters the channel sequence, never edits, never deletes — the "source pinned, ordered
-- replies + count" panel, with no version and no moderation machinery.
--
-- ## Append-only, in the same words as `message_work_links`
--
-- Every column here is what the reply *is* — who said it, under which root, and when — so the
-- trigger below refuses UPDATE wholesale, and `users.sql` grants the runtime credential INSERT
-- and nothing else. There is no edit path and no delete path: a thread reply, once said, is
-- said. `created_at` is the only order the read exposes, and it is engine-defaulted so no
-- caller can place a reply into the middle of a thread it did not write.
--
-- ## Tenant-scoped, and the author is a membership
--
-- `organization_id` is NOT NULL and the row carries `(organization_id, id)`, so the tenant
-- guard scopes its reads and its insert. `author_membership_id` is the membership row that
-- authorised the caller (never a bare user id): the reply belongs to the actor *inside this
-- studio*, and the composite FK to `memberships (organization_id, id)` refuses a membership
-- from another tenant. The root message and the conversation are pinned by composite FKs for
-- the same reason — a reply cannot name another studio's message.

CREATE TABLE conversation_thread_replies (
  id                   CHAR(36)    NOT NULL,
  organization_id      CHAR(36)    NOT NULL,
  conversation_id      CHAR(36)    NOT NULL,
  root_message_id      CHAR(36)    NOT NULL,
  author_membership_id CHAR(36)    NOT NULL,
  body                 TEXT        NOT NULL,
  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_conversation_thread_replies_org_id (organization_id, id),
  -- The read: a message's replies, oldest first. `(organization_id, root_message_id,
  -- created_at)` is the order the list returns and the count aggregates over.
  KEY ix_conversation_thread_replies_root (organization_id, root_message_id, created_at),
  CONSTRAINT fk_conversation_thread_replies_conversation_tenant
    FOREIGN KEY (organization_id, conversation_id) REFERENCES conversations (organization_id, id),
  CONSTRAINT fk_conversation_thread_replies_root_tenant
    FOREIGN KEY (organization_id, root_message_id) REFERENCES messages (organization_id, id),
  CONSTRAINT fk_conversation_thread_replies_author_tenant
    FOREIGN KEY (organization_id, author_membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

-- Append-only. Refused wholesale rather than column by column, for the reason
-- `message_work_links`' trigger gives: there is no column on this table whose change would not
-- falsify the sentence the row exists to make.
CREATE TRIGGER trg_conversation_thread_replies_immutable
BEFORE UPDATE ON conversation_thread_replies FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'conversation_thread_replies rows are immutable';
END$$

DELIMITER ;
