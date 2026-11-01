-- 0275_chat_whatsapp_foundation — one storage for every chat (R7 slice 1; R7-SPEC §3 G1-G9, §4).
--
-- ## conversations
--
-- `kind` says what a conversation is: a project channel (every row before this migration), a
-- group with no project, or a one-to-one direct conversation. `project_id` becomes NULL-able
-- because groups and direct conversations belong to no project. A direct conversation names its
-- two people sorted (`direct_user_low_id` < `direct_user_high_id`), so the pair key makes
-- find-or-create idempotent. Group settings: photo (a scanned `file_assets` row), description,
-- "only admins can send", and an invite token (43 url-safe characters, 256 bits). The list reads
-- `last_message_id` / `last_message_at`, stamped by every post.
--
-- ## conversation_memberships
--
-- `role` (member / admin — a group's creator is its first admin), and per-person `pinned_at` /
-- `archived_at` for the chat list.
--
-- ## messages
--
-- `kind` (text / voice / system / location) and `meta_json`, the per-kind facts the service
-- validates: reply {replyToMessageId, authorUserId, excerpt}; forward {forwardedFromMessageId};
-- voice {durationMs, peaks[]}; location {lat, lng, label}; system {event, userIds[]}.
--
-- ## conversation_read_state
--
-- `last_delivered_message_id` beside `last_read_message_id`, for delivered / read receipts.
--
-- ## user_presence, link_previews (new)
--
-- `user_presence` is one heartbeat row per person per studio (primary key leads with the tenant
-- column, no `id`). `link_previews` is what the worker unfurled for one message's first link.
--
-- ## The conversations identity trigger
--
-- 0007's trigger compared `project_id` with `<>`, which says nothing when either side is NULL.
-- It is re-created with `<=>` and also pins `kind` and the direct pair.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- No generated column, no CHECK, no IF NOT EXISTS in ALTER, literal defaults, DATETIME(3),
-- utf8mb4_unicode_ci, composite tenant keys; the trigger is dropped and re-created.

ALTER TABLE conversations
  ADD COLUMN kind ENUM('project_channel','group','direct') NOT NULL DEFAULT 'project_channel'
    AFTER organization_id,
  MODIFY COLUMN project_id CHAR(36) NULL,
  ADD COLUMN direct_user_low_id CHAR(36) NULL AFTER project_id,
  ADD COLUMN direct_user_high_id CHAR(36) NULL AFTER direct_user_low_id,
  ADD COLUMN photo_file_asset_id CHAR(36) NULL AFTER name,
  ADD COLUMN description VARCHAR(500) NULL AFTER photo_file_asset_id,
  ADD COLUMN only_admins_can_send TINYINT(1) NOT NULL DEFAULT 0 AFTER description,
  ADD COLUMN invite_token CHAR(43) NULL AFTER only_admins_can_send,
  ADD COLUMN last_message_id CHAR(36) NULL AFTER next_sequence_no,
  ADD COLUMN last_message_at DATETIME(3) NULL AFTER last_message_id,
  ADD UNIQUE KEY uq_conversations_direct_pair
    (organization_id, direct_user_low_id, direct_user_high_id),
  ADD UNIQUE KEY uq_conversations_invite (organization_id, invite_token),
  ADD KEY ix_conversations_last_message (organization_id, last_message_at);

ALTER TABLE conversation_memberships
  ADD COLUMN role ENUM('member','admin') NOT NULL DEFAULT 'member' AFTER user_id,
  ADD COLUMN pinned_at DATETIME(3) NULL AFTER role,
  ADD COLUMN archived_at DATETIME(3) NULL AFTER pinned_at;

ALTER TABLE messages
  ADD COLUMN kind ENUM('text','voice','system','location') NOT NULL DEFAULT 'text' AFTER depth,
  ADD COLUMN meta_json JSON NULL AFTER body_rich;

ALTER TABLE conversation_read_state
  ADD COLUMN last_delivered_message_id CHAR(36) NULL AFTER last_read_message_id;

CREATE TABLE user_presence (
  organization_id  CHAR(36)     NOT NULL,
  user_id          CHAR(36)     NOT NULL,
  last_seen_at     DATETIME(3)  NOT NULL,
  PRIMARY KEY (organization_id, user_id),
  CONSTRAINT fk_user_presence_org FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_user_presence_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE link_previews (
  id               CHAR(36)       NOT NULL,
  organization_id  CHAR(36)       NOT NULL,
  message_id       CHAR(36)       NOT NULL,
  url              VARCHAR(2048)  NOT NULL,
  title            VARCHAR(300)   NULL,
  description      VARCHAR(500)   NULL,
  image_url        VARCHAR(2048)  NULL,
  site_name        VARCHAR(120)   NULL,
  status           ENUM('pending','ready','failed') NOT NULL DEFAULT 'pending',
  created_at       DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_link_previews_org_id (organization_id, id),
  UNIQUE KEY uq_link_previews_message (organization_id, message_id),
  KEY ix_link_previews_status (status, created_at),
  CONSTRAINT fk_link_previews_org FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TRIGGER IF EXISTS trg_conversations_immutable;

DELIMITER $$

CREATE TRIGGER trg_conversations_immutable
BEFORE UPDATE ON conversations FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversations.organization_id is immutable';
  END IF;
  IF NOT (NEW.project_id <=> OLD.project_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversations.project_id is immutable';
  END IF;
  IF NEW.kind <> OLD.kind
     OR NOT (NEW.direct_user_low_id <=> OLD.direct_user_low_id)
     OR NOT (NEW.direct_user_high_id <=> OLD.direct_user_high_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversations.kind and the direct pair are immutable';
  END IF;
  IF NEW.created_by_user_id <> OLD.created_by_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversations.created_by_user_id is immutable';
  END IF;
  IF NEW.next_sequence_no < OLD.next_sequence_no THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversations.next_sequence_no may not go backwards';
  END IF;
END$$

DELIMITER ;
