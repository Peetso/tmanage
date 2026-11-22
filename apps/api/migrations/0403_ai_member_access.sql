-- 0403_ai_member_access — the owner's "let AI read files" switch and the members who may not use
-- TManage AI (plan 62, 62-17, journey J1).
--
-- ## What this migration is for
--
-- Plan 62 J1: the owner switches TManage AI on and sets what the AI may do, whether everyday
-- changes run at once, "let AI read files (default on)", the per-member share and "members who may
-- not use it". The first four already live on `ai_workspace_settings` (0383, 0392); this adds the
-- last two.
--
-- - `ai_workspace_settings.file_reading`: the AI may read the text of the workspace's files when a
--   member asks about one (default on, as the plan says). Off, a file question is refused before
--   any model call; knowledge search over other records is unaffected.
-- - `ai_member_blocks` (TENANT): one row per member the owner keeps away from TManage AI. Deleting
--   the row ("Allow again") lifts it. `blocked_by_membership_id` is the owner who set it (never an
--   AI); `created_at` is a bound value (DA-10). The primary key `(organization_id, membership_id)`
--   is the natural idempotency key (HT-4): blocking twice is one row. Every change is audited by
--   the service in the same transaction (DA-11).
--
-- No data is written here: existing workspaces read file reading as on and nobody as blocked.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- One DDL per statement (resumable, DA-8). One literal-default column on a small table
-- (`ai_workspace_settings` has one row per workspace; DA-7) and one new table. No CHECK, no
-- generated column, no functional or partial index, no trigger, no foreign key (the 0257
-- convention). Additive only: old code ignores the new column and table (DA-6).

ALTER TABLE ai_workspace_settings
  ADD COLUMN file_reading TINYINT(1) NOT NULL DEFAULT 1 AFTER run_at_once;

CREATE TABLE ai_member_blocks (
  organization_id          CHAR(36)    NOT NULL,
  membership_id            CHAR(36)    NOT NULL,
  blocked_by_membership_id CHAR(36)    NOT NULL,
  created_at               DATETIME(3) NOT NULL,
  PRIMARY KEY (organization_id, membership_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
