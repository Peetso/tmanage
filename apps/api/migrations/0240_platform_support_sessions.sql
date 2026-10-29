-- 0240_platform_support_sessions — a platform admin entering one organization, on the record.
--
-- ## What this migration is for
--
-- Support mode (SPEC P3, §3.2): a platform admin enters ONE organization for a limited time
-- through a real, hidden membership with the internal role `platform_support`. Each visit is a
-- `platform_support_sessions` row: who, which organization, bound to which browser session,
-- why (optional reason), until when, and how many actions were taken. The membership row points
-- back to it through `memberships.platform_support_session_id`.
--
-- An admin who is already a real member of that organization cannot get a second row
-- (`uq_memberships_org_user`), so the session upgrades their own row for the visit and keeps
-- what it was in `previous_role` / `previous_has_org_wide_scope`, restored on exit.
--
-- ## Global table (NON_TENANT_TABLES)
--
-- `platform_support_sessions` is read before any tenant context exists (the resolver and the
-- platform screens look it up by id), so it is global even though it names an organization.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, literal defaults or CURRENT_TIMESTAMP(3), no generated columns, no CHECK.

CREATE TABLE platform_support_sessions (
  id                          CHAR(36)     NOT NULL,
  admin_user_id               CHAR(36)     NOT NULL,
  browser_session_id          CHAR(36)     NOT NULL,
  organization_id             CHAR(36)     NOT NULL,
  membership_id               CHAR(36)     NULL,
  reason                      VARCHAR(500) NULL,
  started_at                  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at                  DATETIME(3)  NOT NULL,
  ended_at                    DATETIME(3)  NULL,
  ended_reason                VARCHAR(32)  NULL,
  actions_count               INT          NOT NULL DEFAULT 0,
  previous_role               VARCHAR(64)  NULL,
  previous_has_org_wide_scope TINYINT(1)   NULL,
  PRIMARY KEY (id),
  KEY ix_pss_open (organization_id, ended_at, expires_at),
  KEY ix_pss_admin (admin_user_id, started_at),
  CONSTRAINT fk_pss_admin FOREIGN KEY (admin_user_id) REFERENCES users (id),
  CONSTRAINT fk_pss_organization FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE memberships
  ADD COLUMN platform_support_session_id CHAR(36) NULL AFTER has_org_wide_scope,
  ADD KEY ix_memberships_support (platform_support_session_id);
