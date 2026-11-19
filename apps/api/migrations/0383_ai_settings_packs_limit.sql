-- 0383_ai_settings_packs_limit — AI workspace settings, credit packs and the per-workspace credit limit (plan 62, 62-05, B08).
--
-- ## What this migration is for
--
-- - `ai_workspace_settings` (TENANT): one optional row per workspace; no row means every default.
--   Owner settings: `ai_enabled` (off by default), `write_scope` ('read', or 'read_write'; never
--   manage or billing), `run_at_once` (writes that have an undo skip the confirm card; off by
--   default), `member_share_percent` (a member's share of the allowance, 50 by default; the
--   service uses 100 for a one-person workspace). Platform settings: `test_list_at` (the workspace
--   is on the AI test list, the first gate before any spend; NULL = not on it) and `pool_class`
--   ('customers', or 'testing' for internal and test workspaces), both changed only by a platform
--   admin and audited there.
-- - `ai_credit_packs` (TENANT): credits granted on top of the allowance (plan 62 §5). Allowance
--   first, then the oldest pack. `source` is 'grant' (owner requests, platform admin grants) or
--   'purchase' (phase 6, needs a payment provider). A pack expires 6 months after it is granted.
-- - `organization_limits.ai_credits_limit`: a platform admin's raise for one workspace, resolved
--   like the storage limit (plan -> support raise -> cap). NULL means the plan's value, like every
--   other column of that table.
--
-- No data is written here.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Two new tables and one nullable column with no default, one DDL per statement (resumable as
-- 0381: an "already exists" on the statement the counter missed — table or column — is treated as
-- applied). ENUM with literal values, literal defaults, no CHECK, no generated column, no
-- functional or partial index, no trigger, no foreign key (0257 convention). Additive only: old
-- code ignores the new column.

CREATE TABLE ai_workspace_settings (
  id                       CHAR(36)         NOT NULL,
  organization_id          CHAR(36)         NOT NULL,
  ai_enabled               TINYINT(1)       NOT NULL DEFAULT 0,
  write_scope              ENUM('read', 'read_write') NOT NULL DEFAULT 'read',
  run_at_once              TINYINT(1)       NOT NULL DEFAULT 0,
  member_share_percent     TINYINT UNSIGNED NOT NULL DEFAULT 50,
  test_list_at             DATETIME(3)      NULL,
  pool_class               ENUM('customers', 'testing') NOT NULL DEFAULT 'customers',
  updated_by_membership_id CHAR(36)         NULL,
  created_at               DATETIME(3)      NOT NULL,
  updated_at               DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_workspace_settings_org_id (organization_id, id),
  UNIQUE KEY uq_ai_workspace_settings_org (organization_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ai_credit_packs (
  id                         CHAR(36)     NOT NULL,
  organization_id            CHAR(36)     NOT NULL,
  size_credits               INT UNSIGNED NOT NULL,
  remaining_credits          INT UNSIGNED NOT NULL,
  source                     ENUM('grant', 'purchase') NOT NULL,
  requested_by_membership_id CHAR(36)     NULL,
  granted_by_user_id         CHAR(36)     NULL,
  granted_at                 DATETIME(3)  NOT NULL,
  expires_at                 DATETIME(3)  NOT NULL,
  created_at                 DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_credit_packs_org_id (organization_id, id),
  KEY ix_ai_credit_packs_org_expiry (organization_id, expires_at, granted_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE organization_limits
  ADD COLUMN ai_credits_limit INT NULL AFTER storage_bytes_limit;
