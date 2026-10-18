-- 0207_mentions_kind_and_channel_team — CQ-12 (COL-01, COL-05).
--
-- 1. "Mentions" is a notification kind of its own. `notification_kind_prefs.kind` is a closed ENUM
--    (0057) and a new family is a deliberate schema change: 'mention' is appended at the end, so
--    every stored value keeps its meaning and its ordinal.
-- 2. A project channel is the project team's room. Until CQ-12 a new channel held only its
--    creator, so nobody else on the project could see it (COL-01). From now on the API puts the
--    project team in a channel when it is made and puts a person in the project's open channels
--    when they join the project; this backfills the channels that already exist with everyone
--    already on their project. `NOT EXISTS` skips anyone already in, so a re-run adds nothing.
--
-- MariaDB 11.8 / MySQL 8 safe: a plain MODIFY of an ENUM by appending a member, and an
-- INSERT … SELECT. `UUID()` gives the CHAR(36) id both servers accept for these rows.
ALTER TABLE notification_kind_prefs
  MODIFY kind ENUM('client_request', 'work_item', 'message', 'file', 'mention') NOT NULL;

INSERT INTO conversation_memberships (id, organization_id, conversation_id, user_id, created_at)
SELECT UUID(), c.organization_id, c.id, pm.user_id, CURRENT_TIMESTAMP(3)
  FROM conversations c
  JOIN project_memberships pm
    ON pm.organization_id = c.organization_id
   AND pm.project_id = c.project_id
 WHERE c.archived_at IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM conversation_memberships cm
          WHERE cm.organization_id = c.organization_id
            AND cm.conversation_id = c.id
            AND cm.user_id = pm.user_id
       );
