-- 0276_direct_messages_into_conversations — every direct message moves into `conversations` /
-- `messages` (R7 slice 1; R7-SPEC §4 "one storage for all chats").
--
-- A direct conversation becomes a `conversations` row with the SAME id (links and socket
-- subscriptions keep working), `kind = 'direct'`, no project, the sorted pair, and the name
-- `dm:<id>` (never shown; it only keeps the column non-empty). Its messages are copied with their
-- own ids and sequence numbers, so every channel feature (reactions, edit, attachments, replies,
-- pins, bookmarks, read state) now works for direct messages too. Both people get a
-- `conversation_memberships` row. Each side's last-read sequence number becomes a
-- `conversation_read_state` row on the message it pointed at, for a person with an internal
-- membership (client people have no `memberships` row for that table to reference).
--
-- `direct_conversations.deleted_at` maps to `conversations.archived_at` (the table has no soft-
-- delete columns); message soft-delete columns copy across unchanged. A client id that the same
-- author already used on a channel message is dropped (the unique key is author-wide).
--
-- Idempotent: every INSERT is `... SELECT ... WHERE NOT EXISTS`, every UPDATE only fills NULLs,
-- so a re-run after a partial apply finishes the copy without duplicating a row. The old tables
-- stay as they are and nothing reads them any more (dropped in a later migration).

INSERT INTO conversations
  (id, organization_id, kind, project_id, direct_user_low_id, direct_user_high_id, name,
   next_sequence_no, last_message_at, created_by_user_id, version, created_at, updated_at,
   archived_at)
SELECT dc.id, dc.organization_id, 'direct', NULL, dc.user_low_id, dc.user_high_id,
       CONCAT('dm:', dc.id), dc.next_sequence_no, dc.last_message_at, dc.created_by_user_id, 1,
       dc.created_at, dc.updated_at, dc.deleted_at
  FROM direct_conversations dc
 WHERE NOT EXISTS (
         SELECT 1 FROM conversations c
          WHERE c.organization_id = dc.organization_id AND c.id = dc.id);

INSERT INTO messages
  (id, organization_id, conversation_id, author_user_id, sequence_no, parent_message_id, depth,
   parent_depth, kind, body, client_generated_id, deleted_at, deleted_by_user_id, deleted_reason,
   purge_after, created_at, updated_at)
SELECT dm.id, dm.organization_id, dm.direct_conversation_id, dm.author_user_id, dm.sequence_no,
       NULL, 0, NULL, 'text', dm.body,
       CASE WHEN dm.client_generated_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM messages x
               WHERE x.organization_id = dm.organization_id
                 AND x.author_user_id = dm.author_user_id
                 AND x.client_generated_id = dm.client_generated_id)
            THEN NULL ELSE dm.client_generated_id END,
       dm.deleted_at, dm.deleted_by_user_id, dm.deleted_reason, dm.purge_after,
       dm.created_at, dm.created_at
  FROM direct_messages dm
 WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = dm.id);

INSERT INTO conversation_memberships (id, organization_id, conversation_id, user_id, role, created_at)
SELECT UUID(), dc.organization_id, dc.id, dc.user_low_id, 'member', dc.created_at
  FROM direct_conversations dc
 WHERE NOT EXISTS (
         SELECT 1 FROM conversation_memberships cm
          WHERE cm.organization_id = dc.organization_id
            AND cm.conversation_id = dc.id AND cm.user_id = dc.user_low_id);

INSERT INTO conversation_memberships (id, organization_id, conversation_id, user_id, role, created_at)
SELECT UUID(), dc.organization_id, dc.id, dc.user_high_id, 'member', dc.created_at
  FROM direct_conversations dc
 WHERE NOT EXISTS (
         SELECT 1 FROM conversation_memberships cm
          WHERE cm.organization_id = dc.organization_id
            AND cm.conversation_id = dc.id AND cm.user_id = dc.user_high_id);

UPDATE conversations c
  JOIN messages m
    ON m.organization_id = c.organization_id
   AND m.conversation_id = c.id
   AND m.sequence_no = c.next_sequence_no - 1
   SET c.last_message_id = m.id,
       c.last_message_at = COALESCE(c.last_message_at, m.created_at),
       c.updated_at = c.updated_at
 WHERE c.last_message_id IS NULL;

INSERT INTO conversation_read_state
  (id, organization_id, conversation_id, membership_id, last_read_message_id, read_at)
SELECT UUID(), dc.organization_id, dc.id, ms.id, m.id, dc.updated_at
  FROM direct_conversations dc
  JOIN memberships ms
    ON ms.organization_id = dc.organization_id AND ms.user_id = dc.user_low_id
  JOIN messages m
    ON m.organization_id = dc.organization_id
   AND m.conversation_id = dc.id
   AND m.sequence_no = dc.user_low_last_read_sequence_no
 WHERE dc.user_low_last_read_sequence_no > 0
   AND NOT EXISTS (
         SELECT 1 FROM conversation_read_state rs
          WHERE rs.organization_id = dc.organization_id
            AND rs.conversation_id = dc.id AND rs.membership_id = ms.id);

INSERT INTO conversation_read_state
  (id, organization_id, conversation_id, membership_id, last_read_message_id, read_at)
SELECT UUID(), dc.organization_id, dc.id, ms.id, m.id, dc.updated_at
  FROM direct_conversations dc
  JOIN memberships ms
    ON ms.organization_id = dc.organization_id AND ms.user_id = dc.user_high_id
  JOIN messages m
    ON m.organization_id = dc.organization_id
   AND m.conversation_id = dc.id
   AND m.sequence_no = dc.user_high_last_read_sequence_no
 WHERE dc.user_high_last_read_sequence_no > 0
   AND NOT EXISTS (
         SELECT 1 FROM conversation_read_state rs
          WHERE rs.organization_id = dc.organization_id
            AND rs.conversation_id = dc.id AND rs.membership_id = ms.id);
