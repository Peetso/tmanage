-- 0214_direct_conversations — one-to-one direct messages between two members (COL-03, audit gap 7).
--
-- `0007_conversations.sql` built project channels only and said why: `conversations.project_id` is
-- NOT NULL because `conversation.read` is relation-gated on project membership, and a direct
-- message has no project. Rather than make that column nullable under every existing channel
-- query, a direct conversation is its own pair of tables with its own relation rule, applied in
-- `DirectConversationsService`:
--
--   * two internal members of the organization may always talk;
--   * a client person may talk only to someone they share a project with (an internal member of a
--     project shared with their client organization), or to a colleague in the same client
--     organization. Two different client organizations never meet here.
--
-- The rule is re-checked on every read and post, so losing the shared project ends the
-- conversation for both sides without deleting a row.
--
-- ## One row per pair
--
-- `user_low_id` / `user_high_id` are the two user ids in sorted order, written by the service, so
-- `uq_direct_conversations_pair` makes "create or get" idempotent: a race between both people
-- opening the conversation collides on the key and the loser re-reads the winner's row.
--
-- ## Messages are append-only
--
-- `direct_messages` mirrors `messages`' sequence model: `direct_conversations.next_sequence_no` is
-- the allocator, read `FOR UPDATE` inside the insert transaction, with the unique key as the
-- backstop. The runtime credential gets INSERT only on `direct_messages` and the trigger below
-- refuses amendment for every credential.
--
-- MariaDB-safe: plain columns, composite tenant foreign keys, one trigger. No generated columns,
-- no CHECK constraints.

CREATE TABLE direct_conversations (
  id                 CHAR(36)        NOT NULL,
  organization_id    CHAR(36)        NOT NULL,
  -- The two participants, sorted (low < high). Written by the service, never by a caller.
  user_low_id        CHAR(36)        NOT NULL,
  user_high_id       CHAR(36)        NOT NULL,
  next_sequence_no   BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_by_user_id CHAR(36)        NOT NULL,
  -- Moved by every post; the list orders by it (NULL until the first message).
  last_message_at    DATETIME(3)     NULL,
  created_at         DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_direct_conversations_org_id (organization_id, id),
  UNIQUE KEY uq_direct_conversations_pair (organization_id, user_low_id, user_high_id),
  -- "My conversations" reads by either side; the pair key covers the low side.
  KEY ix_direct_conversations_high (organization_id, user_high_id),
  CONSTRAINT fk_direct_conversations_low FOREIGN KEY (user_low_id) REFERENCES users (id),
  CONSTRAINT fk_direct_conversations_high FOREIGN KEY (user_high_id) REFERENCES users (id),
  CONSTRAINT fk_direct_conversations_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE direct_messages (
  id                     CHAR(36)        NOT NULL,
  organization_id        CHAR(36)        NOT NULL,
  direct_conversation_id CHAR(36)        NOT NULL,
  author_user_id         CHAR(36)        NOT NULL,
  -- Allocated from `direct_conversations.next_sequence_no`. Never supplied by a caller.
  sequence_no            BIGINT UNSIGNED NOT NULL,
  body                   TEXT            NOT NULL,
  -- Retry dedupe, scoped like `messages.client_generated_id`.
  client_generated_id    CHAR(36)        NULL,
  created_at             DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_direct_messages_org_id (organization_id, id),
  UNIQUE KEY uq_direct_messages_sequence (organization_id, direct_conversation_id, sequence_no),
  UNIQUE KEY uq_direct_messages_client_generated
    (organization_id, author_user_id, client_generated_id),
  CONSTRAINT fk_direct_messages_conversation_tenant
    FOREIGN KEY (organization_id, direct_conversation_id)
    REFERENCES direct_conversations (organization_id, id),
  CONSTRAINT fk_direct_messages_author FOREIGN KEY (author_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_direct_messages_immutable
BEFORE UPDATE ON direct_messages FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'direct_messages rows are append-only';
END$$

DELIMITER ;
