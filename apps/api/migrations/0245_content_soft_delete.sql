-- 0245_content_soft_delete — every piece of customer content is soft-deleted with a restore window.
--
-- ## What this migration is for
--
-- Platform admin v2 (SPEC P7, slice PA-03): nothing hard-deletes from the UI. A deleted message,
-- comment, document, decision, meeting, file or attachment keeps its row with who removed it, why,
-- and until when it can be restored (`purge_after`); the worker's `--sweep-purge` job removes the
-- row only once that window has passed. Every list read in the owning modules adds
-- `deleted_at IS NULL`, so a deleted row disappears from lists at once while a read by id still
-- returns it (that is how `authorize()`'s `lifecycle: 'soft_deleted'` refuses writes to it).
--
-- Columns added, per table (only what was missing):
--
-- | table                    | deleted_at | deleted_by_user_id | deleted_reason | purge_after |
-- |--------------------------|------------|--------------------|----------------|-------------|
-- | messages                 | (0007)     | (0007)             | added          | added       |
-- | work_items               | (0001)     | added              | added          | added       |
-- | direct_conversations     | added      | added              | added          | added       |
-- | direct_messages          | added      | added              | added          | added       |
-- | message_attachments      | added      | added              | added          | added       |
-- | work_item_comments       | added      | added              | added          | added       |
-- | work_item_files          | added      | added              | added          | added       |
-- | documents                | added      | added              | added          | added       |
-- | document_comments        | added      | added              | added          | added       |
-- | decisions                | added      | added              | added          | added       |
-- | decision_comments        | added      | added              | added          | added       |
-- | meetings                 | added      | added              | added          | added       |
-- | meeting_attachments      | added      | added              | added          | added       |
-- | request_messages         | added      | added              | added          | added       |
-- | request_comments         | added      | added              | added          | added       |
-- | file_assets              | added      | added              | added          | added       |
-- | file_comments            | added      | added              | added          | added       |
-- | project_update_comments  | added      | added              | added          | added       |
-- | google_drive_attachments | added      | added              | added          | added       |
-- | onedrive_attachments     | added      | added              | added          | added       |
--
-- Each table also gains `KEY (organization_id, deleted_at)` (the trash list and the live lists of
-- one organization) and `KEY (purge_after)` (the worker's cross-organization sweep is one range
-- scan instead of a full scan of `messages`).
--
-- ## Append-only tables learn exactly one exception
--
-- Eight tables refused every UPDATE through a blanket `BEFORE UPDATE` trigger (0045, 0053, 0084,
-- 0086, 0167, 0185, 0212, 0214). Their triggers are re-created so that the four soft-delete columns
-- are the only ones that may change; any change to an original column is refused with the same
-- message as before. What was said, by whom and when stays immutable.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain nullable columns with no default expression, plain keys, no CHECK, no generated column,
-- no `IF NOT EXISTS` in ALTER, triggers dropped and re-created with `DROP TRIGGER IF EXISTS`.
-- Additive only: old code ignores the columns.

ALTER TABLE messages
  ADD COLUMN deleted_reason VARCHAR(500) NULL AFTER deleted_by_user_id,
  ADD COLUMN purge_after DATETIME(3) NULL AFTER deleted_reason,
  ADD KEY ix_messages_org_deleted (organization_id, deleted_at),
  ADD KEY ix_messages_purge (purge_after);

ALTER TABLE work_items
  ADD COLUMN deleted_by_user_id CHAR(36) NULL AFTER deleted_at,
  ADD COLUMN deleted_reason VARCHAR(500) NULL AFTER deleted_by_user_id,
  ADD COLUMN purge_after DATETIME(3) NULL AFTER deleted_reason,
  ADD KEY ix_work_items_org_deleted (organization_id, deleted_at),
  ADD KEY ix_work_items_purge (purge_after);

ALTER TABLE direct_conversations
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN deleted_by_user_id CHAR(36) NULL,
  ADD COLUMN deleted_reason VARCHAR(500) NULL,
  ADD COLUMN purge_after DATETIME(3) NULL,
  ADD KEY ix_direct_conversations_org_deleted (organization_id, deleted_at),
  ADD KEY ix_direct_conversations_purge (purge_after);

ALTER TABLE direct_messages
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN deleted_by_user_id CHAR(36) NULL,
  ADD COLUMN deleted_reason VARCHAR(500) NULL,
  ADD COLUMN purge_after DATETIME(3) NULL,
  ADD KEY ix_direct_messages_org_deleted (organization_id, deleted_at),
  ADD KEY ix_direct_messages_purge (purge_after);

ALTER TABLE message_attachments
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN deleted_by_user_id CHAR(36) NULL,
  ADD COLUMN deleted_reason VARCHAR(500) NULL,
  ADD COLUMN purge_after DATETIME(3) NULL,
  ADD KEY ix_message_attachments_org_deleted (organization_id, deleted_at),
  ADD KEY ix_message_attachments_purge (purge_after);

ALTER TABLE work_item_comments
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN deleted_by_user_id CHAR(36) NULL,
  ADD COLUMN deleted_reason VARCHAR(500) NULL,
  ADD COLUMN purge_after DATETIME(3) NULL,
  ADD KEY ix_work_item_comments_org_deleted (organization_id, deleted_at),
  ADD KEY ix_work_item_comments_purge (purge_after);

ALTER TABLE work_item_files
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN deleted_by_user_id CHAR(36) NULL,
  ADD COLUMN deleted_reason VARCHAR(500) NULL,
  ADD COLUMN purge_after DATETIME(3) NULL,
  ADD KEY ix_work_item_files_org_deleted (organization_id, deleted_at),
  ADD KEY ix_work_item_files_purge (purge_after);

ALTER TABLE documents
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN deleted_by_user_id CHAR(36) NULL,
  ADD COLUMN deleted_reason VARCHAR(500) NULL,
  ADD COLUMN purge_after DATETIME(3) NULL,
  ADD KEY ix_documents_org_deleted (organization_id, deleted_at),
  ADD KEY ix_documents_purge (purge_after);

ALTER TABLE document_comments
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN deleted_by_user_id CHAR(36) NULL,
  ADD COLUMN deleted_reason VARCHAR(500) NULL,
  ADD COLUMN purge_after DATETIME(3) NULL,
  ADD KEY ix_document_comments_org_deleted (organization_id, deleted_at),
  ADD KEY ix_document_comments_purge (purge_after);

ALTER TABLE decisions
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN deleted_by_user_id CHAR(36) NULL,
  ADD COLUMN deleted_reason VARCHAR(500) NULL,
  ADD COLUMN purge_after DATETIME(3) NULL,
  ADD KEY ix_decisions_org_deleted (organization_id, deleted_at),
  ADD KEY ix_decisions_purge (purge_after);

ALTER TABLE decision_comments
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN deleted_by_user_id CHAR(36) NULL,
  ADD COLUMN deleted_reason VARCHAR(500) NULL,
  ADD COLUMN purge_after DATETIME(3) NULL,
  ADD KEY ix_decision_comments_org_deleted (organization_id, deleted_at),
  ADD KEY ix_decision_comments_purge (purge_after);

ALTER TABLE meetings
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN deleted_by_user_id CHAR(36) NULL,
  ADD COLUMN deleted_reason VARCHAR(500) NULL,
  ADD COLUMN purge_after DATETIME(3) NULL,
  ADD KEY ix_meetings_org_deleted (organization_id, deleted_at),
  ADD KEY ix_meetings_purge (purge_after);

ALTER TABLE meeting_attachments
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN deleted_by_user_id CHAR(36) NULL,
  ADD COLUMN deleted_reason VARCHAR(500) NULL,
  ADD COLUMN purge_after DATETIME(3) NULL,
  ADD KEY ix_meeting_attachments_org_deleted (organization_id, deleted_at),
  ADD KEY ix_meeting_attachments_purge (purge_after);

ALTER TABLE request_messages
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN deleted_by_user_id CHAR(36) NULL,
  ADD COLUMN deleted_reason VARCHAR(500) NULL,
  ADD COLUMN purge_after DATETIME(3) NULL,
  ADD KEY ix_request_messages_org_deleted (organization_id, deleted_at),
  ADD KEY ix_request_messages_purge (purge_after);

ALTER TABLE request_comments
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN deleted_by_user_id CHAR(36) NULL,
  ADD COLUMN deleted_reason VARCHAR(500) NULL,
  ADD COLUMN purge_after DATETIME(3) NULL,
  ADD KEY ix_request_comments_org_deleted (organization_id, deleted_at),
  ADD KEY ix_request_comments_purge (purge_after);

ALTER TABLE file_assets
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN deleted_by_user_id CHAR(36) NULL,
  ADD COLUMN deleted_reason VARCHAR(500) NULL,
  ADD COLUMN purge_after DATETIME(3) NULL,
  ADD KEY ix_file_assets_org_deleted (organization_id, deleted_at),
  ADD KEY ix_file_assets_purge (purge_after);

ALTER TABLE file_comments
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN deleted_by_user_id CHAR(36) NULL,
  ADD COLUMN deleted_reason VARCHAR(500) NULL,
  ADD COLUMN purge_after DATETIME(3) NULL,
  ADD KEY ix_file_comments_org_deleted (organization_id, deleted_at),
  ADD KEY ix_file_comments_purge (purge_after);

ALTER TABLE project_update_comments
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN deleted_by_user_id CHAR(36) NULL,
  ADD COLUMN deleted_reason VARCHAR(500) NULL,
  ADD COLUMN purge_after DATETIME(3) NULL,
  ADD KEY ix_project_update_comments_org_deleted (organization_id, deleted_at),
  ADD KEY ix_project_update_comments_purge (purge_after);

ALTER TABLE google_drive_attachments
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN deleted_by_user_id CHAR(36) NULL,
  ADD COLUMN deleted_reason VARCHAR(500) NULL,
  ADD COLUMN purge_after DATETIME(3) NULL,
  ADD KEY ix_google_drive_attachments_org_deleted (organization_id, deleted_at),
  ADD KEY ix_google_drive_attachments_purge (purge_after);

ALTER TABLE onedrive_attachments
  ADD COLUMN deleted_at DATETIME(3) NULL,
  ADD COLUMN deleted_by_user_id CHAR(36) NULL,
  ADD COLUMN deleted_reason VARCHAR(500) NULL,
  ADD COLUMN purge_after DATETIME(3) NULL,
  ADD KEY ix_onedrive_attachments_org_deleted (organization_id, deleted_at),
  ADD KEY ix_onedrive_attachments_purge (purge_after);

-- The eight append-only triggers, re-created to admit the soft-delete columns and nothing else.

DROP TRIGGER IF EXISTS trg_work_item_comments_immutable;
DROP TRIGGER IF EXISTS trg_document_comments_immutable;
DROP TRIGGER IF EXISTS trg_project_update_comments_immutable;
DROP TRIGGER IF EXISTS trg_request_comments_immutable;
DROP TRIGGER IF EXISTS trg_decision_comments_immutable;
DROP TRIGGER IF EXISTS trg_request_messages_immutable;
DROP TRIGGER IF EXISTS trg_direct_messages_immutable;
DROP TRIGGER IF EXISTS trg_work_item_files_immutable;

DELIMITER $$

CREATE TRIGGER trg_work_item_comments_immutable
BEFORE UPDATE ON work_item_comments FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id
      AND NEW.organization_id <=> OLD.organization_id
      AND NEW.work_item_id <=> OLD.work_item_id
      AND NEW.author_membership_id <=> OLD.author_membership_id
      AND NEW.body <=> OLD.body
      AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_comments rows are append-only';
  END IF;
END$$

CREATE TRIGGER trg_document_comments_immutable
BEFORE UPDATE ON document_comments FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id
      AND NEW.organization_id <=> OLD.organization_id
      AND NEW.document_id <=> OLD.document_id
      AND NEW.author_membership_id <=> OLD.author_membership_id
      AND NEW.body <=> OLD.body
      AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'document_comments rows are immutable';
  END IF;
END$$

CREATE TRIGGER trg_project_update_comments_immutable
BEFORE UPDATE ON project_update_comments FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id
      AND NEW.organization_id <=> OLD.organization_id
      AND NEW.update_id <=> OLD.update_id
      AND NEW.body <=> OLD.body
      AND NEW.created_by_user_id <=> OLD.created_by_user_id
      AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_update_comments rows are append-only';
  END IF;
END$$

CREATE TRIGGER trg_request_comments_immutable
BEFORE UPDATE ON request_comments FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id
      AND NEW.organization_id <=> OLD.organization_id
      AND NEW.request_id <=> OLD.request_id
      AND NEW.parent_id <=> OLD.parent_id
      AND NEW.body <=> OLD.body
      AND NEW.author_membership_id <=> OLD.author_membership_id
      AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'request_comments rows are append-only';
  END IF;
END$$

CREATE TRIGGER trg_decision_comments_immutable
BEFORE UPDATE ON decision_comments FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id
      AND NEW.organization_id <=> OLD.organization_id
      AND NEW.decision_id <=> OLD.decision_id
      AND NEW.author_membership_id <=> OLD.author_membership_id
      AND NEW.body <=> OLD.body
      AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'decision_comments rows are immutable';
  END IF;
END$$

CREATE TRIGGER trg_request_messages_immutable
BEFORE UPDATE ON request_messages FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id
      AND NEW.organization_id <=> OLD.organization_id
      AND NEW.request_id <=> OLD.request_id
      AND NEW.author_membership_id <=> OLD.author_membership_id
      AND NEW.author_kind <=> OLD.author_kind
      AND NEW.body <=> OLD.body
      AND NEW.client_visible <=> OLD.client_visible
      AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'request_messages rows are append-only';
  END IF;
END$$

CREATE TRIGGER trg_direct_messages_immutable
BEFORE UPDATE ON direct_messages FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id
      AND NEW.organization_id <=> OLD.organization_id
      AND NEW.direct_conversation_id <=> OLD.direct_conversation_id
      AND NEW.author_user_id <=> OLD.author_user_id
      AND NEW.sequence_no <=> OLD.sequence_no
      AND NEW.body <=> OLD.body
      AND NEW.client_generated_id <=> OLD.client_generated_id
      AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'direct_messages rows are append-only';
  END IF;
END$$

CREATE TRIGGER trg_work_item_files_immutable
BEFORE UPDATE ON work_item_files FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id
      AND NEW.organization_id <=> OLD.organization_id
      AND NEW.work_item_id <=> OLD.work_item_id
      AND NEW.file_asset_id <=> OLD.file_asset_id
      AND NEW.attached_by_membership_id <=> OLD.attached_by_membership_id
      AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_files rows are immutable; detach sets deleted_at';
  END IF;
END$$

DELIMITER ;
