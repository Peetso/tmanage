-- 0392_ai_conversations — the in-app AI's conversations, private to the member, and their retention (plan 62, 62-13).
--
-- ## What this migration is for
--
-- Plan 62 §9 62-13: "Conversations: store, list, delete, private to the member; retention setting
-- (default 30 days) and purge."
--
-- - `ai_conversations` (TENANT): one conversation of one member (`membership_id`). `title` is the
--   start of its first message (at most 120 characters), shown in the member's own list only.
--   `last_message_at` drives the list order and the retention purge.
-- - `ai_conversation_messages` (TENANT): the member's messages and the assistant's answers as the
--   member saw them (after the answer guard). `task_id` links an answer to its `ai_tasks` receipt.
--   This is the only place the AI's question and answer text is kept; `ai_tasks` and
--   `ai_usage_ledger` never hold text. Readable by the member who wrote it only: every statement
--   names the organization and the membership (DA-12); an owner or admin has no route to them.
-- - `ai_workspace_settings.conversation_retention_days`: how long a conversation is kept after its
--   last message (default 30; the owner sets 1 to 365). The worker's `ai-conversation-purge` deletes
--   older conversations with their messages, with the bound computed from a JS Date.
--
-- No data is written here.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- One DDL per statement (resumable, DA-8). One literal-default column on a small table
-- (`ai_workspace_settings` has one row per workspace; DA-7), two new tables. ENUM with literal
-- values, literal defaults, no CHECK, no generated column, no functional or partial index, no
-- trigger, no foreign key (the 0257 convention; the purge and the member's delete remove messages
-- before their conversation). Additive only: old code ignores the new column and tables (DA-6).

ALTER TABLE ai_workspace_settings
  ADD COLUMN conversation_retention_days SMALLINT UNSIGNED NOT NULL DEFAULT 30 AFTER pool_class;

CREATE TABLE ai_conversations (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  membership_id   CHAR(36)     NOT NULL,
  title           VARCHAR(120) NOT NULL,
  created_at      DATETIME(3)  NOT NULL,
  last_message_at DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_conversations_org_id (organization_id, id),
  KEY ix_ai_conversations_member (organization_id, membership_id, last_message_at),
  KEY ix_ai_conversations_last (last_message_at, organization_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ai_conversation_messages (
  id              CHAR(36)    NOT NULL,
  organization_id CHAR(36)    NOT NULL,
  conversation_id CHAR(36)    NOT NULL,
  membership_id   CHAR(36)    NOT NULL,
  role            ENUM('member', 'assistant') NOT NULL,
  body            MEDIUMTEXT  NOT NULL,
  task_id         CHAR(36)    NULL,
  created_at      DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_conversation_messages_org_id (organization_id, id),
  KEY ix_ai_conversation_messages_conv (organization_id, conversation_id, created_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
