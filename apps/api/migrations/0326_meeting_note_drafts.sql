-- 0326_meeting_note_drafts — AI meeting notes via the customer's own AI over MCP, reviewed before
-- they are saved (slice 53-13).
--
-- TManage pays for no model. A member's own assistant (Claude, ChatGPT, …), connected over the
-- TManage MCP connector, may *submit a draft* note for a meeting. The draft lands in
-- `meeting_notes` as `status='pending'` with its provenance (`source='mcp'`, the assistant's name,
-- `submitted_at`), and it is not a note until a person in TManage reviews it: they edit the text
-- or the kind and Save it (`status='saved'`, `reviewed_by_user_id`, `reviewed_at`), or Discard it
-- (the pending row is deleted — nothing was ever recorded).
--
-- No new table: a reviewed draft *is* a meeting note, read in the same ordered list as every
-- other note, so it carries the same row shape plus the provenance a reader may want to see.
-- Existing rows and every human capture keep `status='saved'`, `source='human'` by default.
--
-- MariaDB-safe: plain columns with literal defaults, no generated columns, no CHECK on JSON.
--
-- ## The immutable trigger is relaxed to pending rows only
--
-- 0033's trigger refused every UPDATE. A saved note stays exactly as immutable as before; only a
-- `pending` draft may change, and only its `kind`, `body`, `status` and review columns. The
-- identity and provenance columns (who submitted it, from which assistant, when) never change.

ALTER TABLE meeting_notes
  ADD COLUMN status              ENUM('saved','pending') NOT NULL DEFAULT 'saved',
  ADD COLUMN source              ENUM('human','mcp')     NOT NULL DEFAULT 'human',
  ADD COLUMN assistant_name      VARCHAR(120)            NULL,
  ADD COLUMN submitted_at        DATETIME(3)             NULL,
  ADD COLUMN reviewed_by_user_id CHAR(36)                NULL,
  ADD COLUMN reviewed_at         DATETIME(3)             NULL,
  ADD KEY ix_meeting_notes_org_meeting_status (organization_id, meeting_id, status, id),
  ADD CONSTRAINT fk_meeting_notes_reviewer
    FOREIGN KEY (reviewed_by_user_id) REFERENCES users (id);

DROP TRIGGER IF EXISTS trg_meeting_notes_immutable;

DELIMITER $$

CREATE TRIGGER trg_meeting_notes_immutable
BEFORE UPDATE ON meeting_notes FOR EACH ROW
BEGIN
  IF OLD.status <> 'pending'
     OR NOT (NEW.id <=> OLD.id)
     OR NOT (NEW.organization_id <=> OLD.organization_id)
     OR NOT (NEW.meeting_id <=> OLD.meeting_id)
     OR NOT (NEW.author_user_id <=> OLD.author_user_id)
     OR NOT (NEW.created_at <=> OLD.created_at)
     OR NOT (NEW.source <=> OLD.source)
     OR NOT (NEW.assistant_name <=> OLD.assistant_name)
     OR NOT (NEW.submitted_at <=> OLD.submitted_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_notes rows are immutable once saved';
  END IF;
END$$

DELIMITER ;
