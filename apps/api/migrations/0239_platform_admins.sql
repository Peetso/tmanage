-- 0239_platform_admins — a team of platform admins, each with their own permission set.
--
-- ## What this migration is for
--
-- Until now an operator was an address in PLATFORM_ADMIN_EMAILS and every operator could do
-- everything. Platform admin v2 (SPEC P5, §3.1) makes operators data: `platform_admins` holds one
-- row per person with a preset (`super_admin`, `support`, `auditor`, `custom`) and, for `custom`,
-- an explicit permission list. The environment list stays as the bootstrap super admins and is
-- never stored here, so the operator can never lock themselves out from the screen.
--
-- `platform_permission_presets` lets a super admin change which permissions `support` and
-- `auditor` carry (`super_admin` is fixed in code). Rows are written from code on first read.
--
-- `platform_admin_audit_events` gains the organization, the support session, redacted
-- before/after values, the IP and the device, and its reason becomes optional (reads and edits
-- may go without one; the destructive acts still require it in code). `platform_settings`
-- values become TEXT for the banner texts.
--
-- ## Global tables (NON_TENANT_TABLES)
--
-- None of these carries an `organization_id`: they describe the operators, not a tenant.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, VARCHAR vocabularies, TEXT for JSON-ish lists, literal defaults or
-- CURRENT_TIMESTAMP(3), no generated columns, no CHECK, no IF NOT EXISTS in ALTER.

CREATE TABLE platform_admins (
  id               CHAR(36)     NOT NULL,
  user_id          CHAR(36)     NOT NULL,
  preset           VARCHAR(32)  NOT NULL DEFAULT 'support',
  permissions_json TEXT         NULL,
  status           VARCHAR(16)  NOT NULL DEFAULT 'active',
  created_by       CHAR(36)     NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  disabled_at      DATETIME(3)  NULL,
  disabled_reason  VARCHAR(500) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_platform_admins_user (user_id),
  KEY ix_platform_admins_status (status),
  CONSTRAINT fk_platform_admins_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_platform_admins_created_by FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE platform_permission_presets (
  preset           VARCHAR(32)  NOT NULL,
  permissions_json TEXT         NOT NULL,
  updated_by       CHAR(36)     NULL,
  updated_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (preset)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE platform_admin_audit_events
  MODIFY action VARCHAR(96) NOT NULL,
  ADD COLUMN organization_id CHAR(36) NULL AFTER target_label,
  ADD COLUMN support_session_id CHAR(36) NULL,
  ADD COLUMN before_json TEXT NULL,
  ADD COLUMN after_json TEXT NULL,
  ADD COLUMN ip VARCHAR(45) NULL,
  ADD COLUMN user_agent VARCHAR(255) NULL,
  MODIFY reason VARCHAR(500) NULL,
  ADD KEY ix_paae_org_time (organization_id, created_at),
  ADD KEY ix_paae_support (support_session_id);

ALTER TABLE platform_settings
  MODIFY setting_value TEXT NOT NULL;
