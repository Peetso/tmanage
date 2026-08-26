-- 0007_conversations — the thing a studio does all day, and could not do here (CHAT-001).
--
-- Governing sources: 13-ENGINEERING-EXECUTION-SPEC.md §5 (the table list names
-- `conversations`, `conversation_memberships`, `messages`), 23-ERD-AND-STATE-MACHINES.md §2
-- (`PROJECT ||--o{ CONVERSATION` and `CONVERSATION ||--o{ MESSAGE`) and §4 ("Message sequence
-- unique on `(organization_id, conversation_id, sequence_no)`"; "Client-generated
-- message/command ID unique within actor/organization for dedupe"), 22-SCREEN-BY-SCREEN-SPEC.md
-- §4 TM-06/TM-07/TM-08, 27-TEST-CATALOG.md INT-08, 12-PERMISSION-MATRIX.md §2 ("Moderate
-- messages"), 07-DATA-MODEL.md §9 (index prefixes).
--
-- ## What this migration is for
--
-- Five tickets built a client request loop that works at both ends, and the largest thing
-- standing between it and a team using it is that **nothing here can hold a conversation**.
-- A manager can ask a client one question and the client is told to reply however they
-- normally reach the studio. `13-ENGINEERING` §5 has named these three tables since the plan
-- was written and none of them existed.
--
-- ## Project channels only, and the omission is the interesting part
--
-- `22` §4 has TM-06 project channels *and* TM-07 direct/group messages, and this migration
-- builds only the first: `conversations.project_id` is `NOT NULL`.
--
-- The reason is authorization rather than effort. `conversation.read` is relation-gated in
-- `packages/domain/src/policies/authorize.ts`, and the relation it checks is **project
-- membership**. A conversation with no project has no relation for the evaluator to check, so
-- every internal principal holding the capability would pass — which is the correct answer for
-- a project channel and precisely the wrong one for a direct message between two people. TM-07
-- therefore needs a relation the evaluator does not have, and inventing one inside a storage
-- migration is how an authorization core acquires a rule nobody reviewed.
--
-- There is deliberately **no `kind` column** with one legal value in it, for the same reason
-- `client_requests.category` was left as free text: a vocabulary no screen agreed to is worse
-- than no vocabulary. When TM-07 arrives it makes `project_id` nullable and adds the
-- discriminator then, alongside the evaluator change that makes it safe.
--
-- ## The sequence number is the whole of "thread sequence model"
--
-- `23-ERD` §4 requires `(organization_id, conversation_id, sequence_no)` to be unique and
-- INT-08 requires it to be monotonic per conversation. `conversations.next_sequence_no` is the
-- allocator: a message insert reads it `FOR UPDATE`, writes the value it read, and increments
-- it, all inside the transaction that inserts the message. Two concurrent authors serialise on
-- that row lock, and the unique key above is the backstop that turns a bug in the allocator
-- into a failed insert rather than into two messages numbered alike.
--
-- `MAX(sequence_no) + 1` was the obvious alternative and it is wrong under concurrency without
-- a lock of its own, and the row it would have to lock is the row it is trying to insert.
--
-- A consequence worth naming: appending a message updates `conversations`, so the channel's
-- `updated_at` moves when somebody speaks. That is wanted — it is the channel's last-activity
-- time — but it means `updated_at` on this table is not "when the channel was renamed".
--
-- ## Threads are exactly one level deep, and InnoDB is what enforces it
--
-- `22` §4 TM-08 draws a thread as a source message with replies. It does not draw a reply to a
-- reply, and a tree would make "the thread pane" an unbounded recursion rather than a panel.
--
-- Enforcing that needs a fact about the *parent* row, which a trigger cannot read: MySQL will
-- not let a trigger query its own subject table. So the fact is carried in the key instead.
-- `depth` is 0 for a root and 1 for a reply, `(organization_id, id, depth)` is unique, and a
-- reply's foreign key names `(organization_id, parent_message_id, 0)` — so the parent must be
-- a row whose depth is 0. `parent_depth` exists only to give that foreign key its third
-- column; it is `0` whenever there is a parent and `NULL` otherwise, and the trigger below
-- refuses any other combination. A reply to a reply fails at the engine, on a direct SQL
-- session as much as through the application.
--
-- The redundant column is the price of an invariant InnoDB holds rather than one the service
-- promises. ADR-0001 layers 3 and 4 are application-side; this is a rule that survives them.
--
-- ## A message is never deleted, and the grant says so
--
-- `12-PERMISSION-MATRIX` §2 has a "Moderate messages" row, so a message can be removed from
-- view — `deleted_at` and `deleted_by_user_id` record that it was and by whom. `users.sql`
-- grants no DELETE on `messages`, so the row survives the moderation: "this was said and then
-- taken down, by this person, at this time" is the sentence a moderation log exists to make,
-- and a hard delete makes it unsayable.
--
-- `conversation_memberships` **is** deletable, following `project_memberships`: leaving a
-- channel is not a moderation act and the audit row records the facts the DELETE destroys.

CREATE TABLE conversations (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- NOT NULL. See the note above about TM-07.
  project_id         CHAR(36)     NOT NULL,
  -- `19-SEED-DATA-AND-COPY` writes a channel as `#atlas-relaunch`, so the name is the handle
  -- rather than a title. The `#` is presentation and is not stored.
  name               VARCHAR(120) NOT NULL,
  -- The allocator. See the note above; a message insert takes this row's lock.
  next_sequence_no   BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_by_user_id CHAR(36)     NOT NULL,
  -- Optimistic concurrency (25-AUTH-AND-TENANT-ISOLATION §3 step 7), for renames. It is
  -- **not** touched by appending a message: a message is not a change to the channel.
  version            BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3),
  -- Archived rather than deleted. `authorize()` already refuses a write against an archived
  -- resource and admits an internal read, which is what a closed channel should be.
  archived_at        DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_conversations_org_id (organization_id, id),
  -- One `#general` per project. The name is a handle people type, so two channels answering
  -- to it in the same project is a bug rather than a preference.
  UNIQUE KEY uq_conversations_project_name (organization_id, project_id, name),
  CONSTRAINT fk_conversations_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_conversations_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- `project_memberships`' shape exactly, and for the same reasons: identity unique per tenant,
-- a user index for "which channels am I in", composite tenant foreign keys.
--
-- There is no `role` column. `12-PERMISSION-MATRIX` §2 makes "Moderate messages" a property of
-- the organization role — Owner and Org Admin at scope, Manager and Moderator per project,
-- everyone else own-only — and not of a per-channel grant. A second role vocabulary here would
-- be a second opinion about who may moderate, free to disagree with §2.
CREATE TABLE conversation_memberships (
  id              CHAR(36)    NOT NULL,
  organization_id CHAR(36)    NOT NULL,
  conversation_id CHAR(36)    NOT NULL,
  user_id         CHAR(36)    NOT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_conversation_memberships_org_id (organization_id, id),
  UNIQUE KEY uq_conversation_memberships_identity
    (organization_id, conversation_id, user_id),
  KEY ix_conversation_memberships_user (organization_id, user_id),
  CONSTRAINT fk_conversation_memberships_conversation_tenant
    FOREIGN KEY (organization_id, conversation_id)
    REFERENCES conversations (organization_id, id),
  CONSTRAINT fk_conversation_memberships_user
    FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE messages (
  id                  CHAR(36)     NOT NULL,
  organization_id     CHAR(36)     NOT NULL,
  conversation_id     CHAR(36)     NOT NULL,
  author_user_id      CHAR(36)     NOT NULL,
  -- Allocated from `conversations.next_sequence_no`. Never supplied by a caller.
  sequence_no         BIGINT UNSIGNED NOT NULL,
  -- NULL for a top-level message; a root message's id for a reply.
  parent_message_id   CHAR(36)     NULL,
  -- 0 root, 1 reply. Half of the thread-depth invariant; the trigger below holds the other.
  depth               TINYINT UNSIGNED NOT NULL DEFAULT 0,
  -- Exists only to give `fk_messages_parent_is_root` a third column to reference, so that a
  -- parent must be a row with `depth = 0`. Always 0 when `parent_message_id` is set and NULL
  -- when it is not; anything else is refused by the trigger.
  parent_depth        TINYINT UNSIGNED NULL,
  -- Plain text as of CHAT-001. `CHAT-002` is "create/read messages and sanitized rich-text",
  -- and it is the ticket that decides what markup is admissible and sanitises it. Storing
  -- rich text here first would mean storing it before anything could sanitise it.
  body                TEXT         NOT NULL,
  -- `23-ERD` §4's retry dedupe. Optional: a caller that does not send one gets no protection
  -- and no error, and the unique key below admits many NULLs, which is what that means.
  client_generated_id CHAR(36)     NULL,
  -- `22` §4 TM-06 lists "edit history" among the message actions. This column records *that*
  -- an edit happened; the history itself is `CHAT-002`'s and has no table here yet.
  edited_at           DATETIME(3)  NULL,
  -- Moderation, per §2's "Moderate messages". The row stays; see the note above.
  deleted_at          DATETIME(3)  NULL,
  deleted_by_user_id  CHAR(36)     NULL,
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                   ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- `depth` is in this key so that `fk_messages_parent_is_root` has something to reference.
  -- `(organization_id, id)` is already unique, so adding a column keeps it unique.
  UNIQUE KEY uq_messages_org_id_depth (organization_id, id, depth),
  -- `23-ERD` §4 and INT-08. The backstop under the allocator, and the index the channel is
  -- read by: a conversation's messages in the order they were said.
  UNIQUE KEY uq_messages_sequence (organization_id, conversation_id, sequence_no),
  -- `23-ERD` §4: "Client-generated message/command ID unique within actor/organization".
  UNIQUE KEY uq_messages_client_generated
    (organization_id, author_user_id, client_generated_id),
  -- TM-08's thread pane: one root's replies, in order.
  KEY ix_messages_thread (organization_id, conversation_id, parent_message_id, sequence_no),
  CONSTRAINT fk_messages_conversation_tenant
    FOREIGN KEY (organization_id, conversation_id)
    REFERENCES conversations (organization_id, id),
  -- The thread-depth invariant, as a key. A reply names its parent *and* asserts that the
  -- parent's depth is 0; InnoDB refuses the row if it is not. Composite and nullable, so a
  -- top-level message — whose `parent_message_id` and `parent_depth` are both NULL — is
  -- unconstrained, because InnoDB does not check a composite foreign key containing a NULL.
  CONSTRAINT fk_messages_parent_is_root
    FOREIGN KEY (organization_id, parent_message_id, parent_depth)
    REFERENCES messages (organization_id, id, depth),
  CONSTRAINT fk_messages_author
    FOREIGN KEY (author_user_id) REFERENCES users (id),
  CONSTRAINT fk_messages_deleted_by
    FOREIGN KEY (deleted_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rules at the engine, for the reason every other trigger in this schema exists: ADR-0001
-- layers 3 and 4 are application-side, and a direct SQL session bypasses both.
--
-- 1. **A thread is one level deep or the row does not exist.** The foreign key above proves the
--    parent is a root. These statements prove the three columns agree with each other, which
--    the foreign key cannot: without them `depth = 0` with a parent, or `depth = 1` with none,
--    would both be storable, and the pane that reads `parent_message_id IS NULL` and the pane
--    that reads `depth = 0` would draw different threads.
-- 2. **Identity is immutable.** `organization_id` for the reason it is immutable everywhere.
--    `conversation_id`, `author_user_id`, `sequence_no`, `parent_message_id` and `depth`
--    because they are what the message *is*: moving a message to another channel, or renumbering
--    it, would rewrite a record of who said what, in what order, in front of whom. Editing is a
--    change to `body` and `edited_at` and to nothing else.
DELIMITER $$

CREATE TRIGGER trg_messages_thread_coherent
BEFORE INSERT ON messages FOR EACH ROW
BEGIN
  IF NEW.parent_message_id IS NULL AND (NEW.depth <> 0 OR NEW.parent_depth IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'messages with no parent must have depth 0 and no parent_depth';
  END IF;
  IF NEW.parent_message_id IS NOT NULL AND (NEW.depth <> 1 OR NEW.parent_depth <> 0) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'messages with a parent must have depth 1 and parent_depth 0';
  END IF;
END$$

CREATE TRIGGER trg_messages_immutable
BEFORE UPDATE ON messages FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'messages.organization_id is immutable';
  END IF;
  IF NEW.conversation_id <> OLD.conversation_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'messages.conversation_id is immutable';
  END IF;
  IF NEW.author_user_id <> OLD.author_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'messages.author_user_id is immutable';
  END IF;
  IF NEW.sequence_no <> OLD.sequence_no THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'messages.sequence_no is immutable';
  END IF;
  IF NOT (NEW.parent_message_id <=> OLD.parent_message_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'messages.parent_message_id is immutable';
  END IF;
  IF NEW.depth <> OLD.depth THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'messages.depth is immutable';
  END IF;
END$$

-- A conversation's tenant and project are what it is, for the reason `client_requests`'
-- trigger gives: re-pointing a channel at another project would move every message in it,
-- silently, into a room a different set of people can read.
CREATE TRIGGER trg_conversations_immutable
BEFORE UPDATE ON conversations FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversations.organization_id is immutable';
  END IF;
  IF NEW.project_id <> OLD.project_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversations.project_id is immutable';
  END IF;
  IF NEW.created_by_user_id <> OLD.created_by_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversations.created_by_user_id is immutable';
  END IF;
  -- The allocator only ever moves forward. A sequence number that could be handed out twice
  -- would break INT-08 in the one way the unique key cannot report usefully.
  IF NEW.next_sequence_no < OLD.next_sequence_no THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversations.next_sequence_no may not go backwards';
  END IF;
END$$

CREATE TRIGGER trg_conversation_memberships_immutable
BEFORE UPDATE ON conversation_memberships FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversation_memberships.organization_id is immutable';
  END IF;
  IF NEW.conversation_id <> OLD.conversation_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversation_memberships.conversation_id is immutable';
  END IF;
  IF NEW.user_id <> OLD.user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'conversation_memberships.user_id is immutable';
  END IF;
END$$

DELIMITER ;
