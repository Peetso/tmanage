-- 0242_membership_permission_overrides — per-person allow/deny on top of a member's role.
--
-- ## What this migration is for
--
-- Platform admin v2 (SPEC §3.3 "Per-member overrides", §6 0242). The permission matrix lets an
-- owner, an org admin, a role holding `roles.assign`, or a platform admin give ONE member a
-- capability their role does not carry (`allow`) or take one away (`deny`), optionally until a
-- date. `authorize()` step 3 reads them from the principal: allowed = (role holds it OR an allow
-- names it) AND no deny names it; org policy and the internal-only guard still run after.
--
-- ## Revoked, never deleted
--
-- Removing an override sets `revoked_at` / `revoked_by`; the row stays as the record of who gave
-- what and when. The runtime credential gets SELECT, INSERT and UPDATE only (scripts/db/users.sql),
-- never DELETE. `uq_mpo_live` keys on `revoked_at`: MariaDB/MySQL let several NULLs through a unique
-- key, so "one live row per capability" is kept by the writer (revoke, then insert, in one
-- transaction); the key still stops two revocations of the same capability at the same instant.
--
-- ## Tenant table
--
-- `organization_id` leads every key and `(organization_id, id)` is unique, like every tenant table.
-- The composite FK pins an override to an internal membership of the same organization. A client
-- override (`audience = 'client'`) would name a `client_memberships` id, which this FK cannot
-- reference; the column is there for that later step and the code refuses internal-only
-- capabilities for clients either way.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, VARCHAR vocabularies (no ENUM), literal defaults or CURRENT_TIMESTAMP(3), no
-- generated columns, no CHECK, utf8mb4_unicode_ci.

CREATE TABLE membership_permission_overrides (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  membership_id   CHAR(36)     NOT NULL,
  -- 'internal' (a `memberships` row) or 'client' (reserved; see the header).
  audience        VARCHAR(16)  NOT NULL DEFAULT 'internal',
  -- One allowlisted capability string from packages/domain `CAPABILITIES`.
  capability      VARCHAR(64)  NOT NULL,
  -- 'allow' or 'deny'.
  effect          VARCHAR(8)   NOT NULL,
  reason          VARCHAR(500) NULL,
  expires_at      DATETIME(3)  NULL,
  created_by      CHAR(36)     NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at      DATETIME(3)  NULL,
  revoked_by      CHAR(36)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mpo_org_id (organization_id, id),
  UNIQUE KEY uq_mpo_live (organization_id, membership_id, capability, revoked_at),
  KEY ix_mpo_membership (organization_id, membership_id, revoked_at),
  CONSTRAINT fk_mpo_membership FOREIGN KEY (organization_id, membership_id)
    REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_mpo_created_by FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT fk_mpo_revoked_by FOREIGN KEY (revoked_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
