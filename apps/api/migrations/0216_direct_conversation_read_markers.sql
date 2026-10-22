-- 0216_direct_conversation_read_markers — per-participant last-read position for direct messages
-- (BK3-left: the Figma d-conversation list shows an unread count per conversation).
--
-- A direct conversation has exactly two participants, already stored sorted as `user_low_id` /
-- `user_high_id` (0214), so each one's read marker is a column on the pair row rather than a
-- third table: one row read answers "how many unread" for the caller with no join and no count
-- over `direct_messages`:
--
--   unread = (next_sequence_no - 1) - <caller's last_read_sequence_no>
--
-- That holds because posting advances the author's own marker to the message they just sent
-- (`DirectConversationsRepository.appendMessage`), so every message past a participant's marker
-- is from the other person. Mark-read only ever moves a marker forward (GREATEST) and never past
-- the allocator, and it writes `updated_at = updated_at` so reading a conversation does not
-- reorder the list (which orders by activity).
--
-- The runtime credential already holds UPDATE on `direct_conversations` (users.sql, 0214); no
-- grant changes. MariaDB-safe: two plain columns with constant defaults, no generated column,
-- no CHECK constraint.

ALTER TABLE direct_conversations
  ADD COLUMN user_low_last_read_sequence_no  BIGINT UNSIGNED NOT NULL DEFAULT 0
    AFTER next_sequence_no,
  ADD COLUMN user_high_last_read_sequence_no BIGINT UNSIGNED NOT NULL DEFAULT 0
    AFTER user_low_last_read_sequence_no;
