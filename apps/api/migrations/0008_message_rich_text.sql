-- 0008_message_rich_text — what a message may say beyond plain characters, and what it said
-- before it was edited (CHAT-002).
--
-- Governing sources: 04-SECURITY-PRIVACY.md §6 ("sanitized rich-text allowlist"),
-- 27-TEST-CATALOG.md SEC-08 (stored XSS in messages), 22-SCREEN-BY-SCREEN-SPEC.md §4 TM-06
-- ("edit history" among the message actions), 24-EVENT-CATALOG.md §1 (full message bodies are
-- forbidden from durable events), 28-SPRINT-TICKETS §6 CHAT-002.
--
-- ## What this migration is for
--
-- CHAT-001 stored a message body as plain text and named the decision's shelf life in its own
-- migration: rich text stored before anything can sanitise it is rich text nobody can safely
-- render. The sanitiser now exists — `packages/domain/src/value-objects/rich-text.ts`, an
-- allowlist over a closed JSON grammar, applied at the write boundary the way
-- `assertSafeAuditMetadata` is. This migration adds the column the sanitised document lives
-- in, and the table CHAT-001 owed TM-06: `edited_at` said a message had changed and nothing
-- said from what.
--
-- ## `body_rich` is a second representation, not a second truth
--
-- `body` stays, and stays `NOT NULL`: it is the plain text a rich document *derives to* —
-- `richTextToPlainText` — so a search, an export, or a surface that cannot draw marks always
-- has something true to show. The application writes both columns from one sanitised source,
-- so they cannot disagree about what was said. `body_rich` is NULL for a plain-text message,
-- which is every message CHAT-001 stored and every message posted without markup since.
-- There is no backfill because there is nothing to backfill from: a plain body does not say
-- which of its characters were meant as emphasis.
--
-- ## The edit history is written by the engine, not promised by the application
--
-- `message_revisions` holds the body a message had *before* each change, and the trigger
-- below is what writes it. The alternative — the service inserting a revision row beside its
-- UPDATE — promises history only on the paths that remember to; a direct SQL session, or a
-- later repository method written in a hurry, would rewrite a message and leave no trace.
-- MySQL triggers fire with the *definer's* privileges, so the recorder works although the
-- runtime credential holds no INSERT on `message_revisions` at all — the application cannot
-- forge a revision, cannot suppress one, and cannot delete one. History is a consequence of
-- editing, not a courtesy of the editor.
--
-- The same trigger forces `edited_at` forward whenever the body changes, which upgrades
-- CHAT-001's "there is no path that changes what somebody said without recording that it
-- changed" from a property of the repository to a property of the table.
--
-- ## Why there is no `id` and no `edited_by_user_id`
--
-- Every other table here has a CHAR(36) UUIDv7 primary key, allocated by the application.
-- These rows are engine-authored: the engine has no UUIDv7, and MySQL's UUID() is a v1 that
-- would silently break the id convention it appeared to follow. The natural key
-- `(organization_id, message_id, revision_no)` is the honest one — a revision *is* "the nth
-- body this message had".
--
-- `edited_by_user_id` is absent because it would be a claim the engine cannot verify. Only a
-- message's author may edit it — `ConversationsService.editMessage` enforces that and
-- `12-PERMISSION-MATRIX` §2 is why — so the editor is `messages.author_user_id`, already
-- recorded. A column filled in by the very session whose honesty is in question would be
-- weaker than the derivation it replaced.

ALTER TABLE messages
  -- The sanitised rich-text document, exactly as admitted by the allowlist. NULL means the
  -- message is plain text. JSON rather than TEXT so the engine refuses a value that is not
  -- even JSON; what is *admissible* JSON is the write boundary's decision and cannot be the
  -- engine's, because the grammar lives in the domain package where a review can read it.
  ADD COLUMN body_rich JSON NULL AFTER body;

CREATE TABLE message_revisions (
  organization_id CHAR(36)        NOT NULL,
  message_id      CHAR(36)        NOT NULL,
  -- 1 for the body the message was created with, counting up. Allocated under the message
  -- row's lock — the UPDATE that fires the trigger holds it — so two edits cannot collide.
  revision_no     BIGINT UNSIGNED NOT NULL,
  -- The body as it stood BEFORE the edit that displaced it. The current body lives on the
  -- message row; the full history is these rows in order, then that.
  body            TEXT            NOT NULL,
  body_rich       JSON            NULL,
  -- When this body was written: the message's created_at for revision 1, the previous edit's
  -- edited_at after that.
  written_at      DATETIME(3)     NOT NULL,
  -- When this body stopped being current — the edit that displaced it.
  replaced_at     DATETIME(3)     NOT NULL,
  PRIMARY KEY (organization_id, message_id, revision_no),
  CONSTRAINT fk_message_revisions_message_tenant
    FOREIGN KEY (organization_id, message_id) REFERENCES messages (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

-- The recorder. BEFORE UPDATE, created after 0007's `trg_messages_immutable` so the
-- immutability check has already refused anything it is going to refuse by the time this
-- runs — a refused UPDATE writes no revision.
--
-- The MAX(...) read is a locking read (FOR UPDATE): the transaction's snapshot may predate a
-- concurrent editor's commit, and a stale MAX would allocate a duplicate revision_no. The
-- message row's own lock already serialises editors; the locking read makes the allocator
-- read what the previous editor wrote rather than what this transaction started from.
CREATE TRIGGER trg_messages_record_revision
BEFORE UPDATE ON messages FOR EACH ROW
BEGIN
  DECLARE next_revision BIGINT UNSIGNED;
  IF NEW.body <> OLD.body OR NOT (NEW.body_rich <=> OLD.body_rich) THEN
    SET NEW.edited_at = CURRENT_TIMESTAMP(3);
    SELECT COALESCE(MAX(revision_no), 0) + 1 INTO next_revision
      FROM message_revisions
     WHERE organization_id = OLD.organization_id AND message_id = OLD.id
       FOR UPDATE;
    INSERT INTO message_revisions
      (organization_id, message_id, revision_no, body, body_rich, written_at, replaced_at)
    VALUES
      (OLD.organization_id, OLD.id, next_revision, OLD.body, OLD.body_rich,
       COALESCE(OLD.edited_at, OLD.created_at), NEW.edited_at);
  END IF;
END$$

-- A revision is a record of what was said, and a record that can be updated is a draft.
-- Refused wholesale rather than column by column: there is no column on this table whose
-- change would not falsify history.
CREATE TRIGGER trg_message_revisions_immutable
BEFORE UPDATE ON message_revisions FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'message_revisions rows are immutable';
END$$

DELIMITER ;
