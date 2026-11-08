-- 0324_support_threads — in-app support conversations to the platform team (55-17).
--
-- ## What this migration is for
--
-- A signed-in person opens "Contact support" from the shell's help menu and writes to the TManage
-- platform team. One conversation is a `support_threads` row; every message in it (the person's
-- first message, the team's replies, the person's follow-ups) is a `support_messages` row.
--
-- - `status` is one of `open` (the team owes an answer), `waiting` (the team answered and waits
--   for the person) or `closed`. The closed list is checked in `support/support.policy.ts`.
-- - `context_path` and `context_app_version` are the page and app version the person was on, shown
--   to them before sending. The organization is the thread's own `organization_id`; its slug is
--   read from `organizations` at display time, never stored from the request.
-- - A message may name one screenshot uploaded through the existing upload pipeline
--   (`attachment_file_id`, a `file_assets` id of the same organization, checked by the service).
-- - `author_kind` is `member` (someone in the organization) or `platform` (the TManage team).
--
-- TENANT: both tables are keyed `(organization_id, id)`. Members read and write them through their
-- own context (a person sees the threads they started; an org admin sees all of the
-- organization's). The platform team lists across organizations only through the platform-admin
-- path (`bootstrapRead` with a recorded reason) and writes under a service context for the
-- thread's organization, with a platform audit row.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATETIME(3), no generated columns, no CHECK, no functional or partial indexes,
-- utf8mb4_unicode_ci. Additive only: two new tables.

CREATE TABLE support_threads (
  id                     CHAR(36)      NOT NULL,
  organization_id        CHAR(36)      NOT NULL,
  started_by_user_id     CHAR(36)      NOT NULL,
  subject                VARCHAR(160)  NOT NULL,
  status                 VARCHAR(16)   NOT NULL DEFAULT 'open',
  context_path           VARCHAR(300)  NULL,
  context_app_version    VARCHAR(40)   NULL,
  message_count          INT UNSIGNED  NOT NULL DEFAULT 0,
  last_message_at        DATETIME(3)   NOT NULL,
  last_author_kind       VARCHAR(16)   NOT NULL DEFAULT 'member',
  created_at             DATETIME(3)   NOT NULL,
  updated_at             DATETIME(3)   NOT NULL,
  closed_at              DATETIME(3)   NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_support_threads_org_id (organization_id, id),
  KEY ix_support_threads_org_starter (organization_id, started_by_user_id, last_message_at),
  KEY ix_support_threads_status_last (status, last_message_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE support_messages (
  id                     CHAR(36)      NOT NULL,
  organization_id        CHAR(36)      NOT NULL,
  thread_id              CHAR(36)      NOT NULL,
  author_kind            VARCHAR(16)   NOT NULL,
  author_user_id         CHAR(36)      NOT NULL,
  body                   TEXT          NOT NULL,
  attachment_file_id     CHAR(36)      NULL,
  attachment_name        VARCHAR(255)  NULL,
  created_at             DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_support_messages_org_id (organization_id, id),
  KEY ix_support_messages_thread (organization_id, thread_id, created_at),
  CONSTRAINT fk_support_messages_thread
    FOREIGN KEY (organization_id, thread_id) REFERENCES support_threads (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
