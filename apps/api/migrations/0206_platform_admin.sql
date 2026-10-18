-- 0206_platform_admin — the TManage operator surface ("Platform admin", /platform).
--
-- Governing source: 29-ENVIRONMENTS-DEPLOYMENT-AND-RUNBOOKS §12 (support access): no routine
-- direct database access, safe diagnostics only, no impersonation. Who is an operator is the
-- PLATFORM_ADMIN_EMAILS environment variable, not a table, so nothing here grants authority.
--
-- ## A company can be suspended
--
-- `organizations.suspended_at`: NULL is active. A suspended company's members are refused at
-- the membership resolver with "workspace suspended, contact support"; nothing is deleted.
--
-- ## Three global tables, registered in NON_TENANT_TABLES
--
-- None carries an `organization_id`: they describe the operator and the service, not a tenant.
--
-- - `platform_admin_step_ups` — a fresh password (+ two-step code) confirmation, bound to one
--   session, valid 15 minutes. Every platform route except "who am I" needs a live one.
-- - `platform_admin_audit_events` — every platform action: who, when, the typed reason, the
--   target. Append-only by grant (INSERT and SELECT only), like `audit_events`.
-- - `platform_settings` — operator switches. Today one row: `public_signup` = open/closed,
--   which overrides the PUBLIC_SIGNUP environment default once set.
--
-- MariaDB-safe: plain columns, no generated columns, no JSON, no expression defaults beyond
-- CURRENT_TIMESTAMP(3) (Hostinger runs MariaDB; see the 2026-10-17 deploy note on 0011).

ALTER TABLE organizations
  ADD COLUMN suspended_at DATETIME(3) NULL AFTER archived_at;

CREATE TABLE platform_admin_step_ups (
  id            CHAR(36)    NOT NULL,
  user_id       CHAR(36)    NOT NULL,
  session_id    CHAR(36)    NOT NULL,
  mfa_verified  TINYINT(1)  NOT NULL DEFAULT 0,
  expires_at    DATETIME(3) NOT NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_platform_admin_step_ups_session (user_id, session_id, expires_at),
  CONSTRAINT fk_platform_admin_step_ups_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE platform_admin_audit_events (
  id              CHAR(36)     NOT NULL,
  actor_user_id   CHAR(36)     NOT NULL,
  actor_email     VARCHAR(254) NOT NULL,
  action          VARCHAR(64)  NOT NULL,
  target_type     VARCHAR(32)  NOT NULL,
  target_id       CHAR(36)     NULL,
  target_label    VARCHAR(254) NULL,
  reason          VARCHAR(500) NOT NULL,
  correlation_id  CHAR(36)     NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_platform_admin_audit_events_time (created_at),
  KEY ix_platform_admin_audit_events_target (target_type, target_id, created_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE platform_settings (
  setting_key         VARCHAR(64)  NOT NULL,
  setting_value       VARCHAR(255) NOT NULL,
  updated_by_user_id  CHAR(36)     NULL,
  updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
