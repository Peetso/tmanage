-- 0202_personal_access_tokens — per-member API credentials for MCP clients.
--
-- Governing sources: 25-AUTHORIZATION-AND-TENANT-ISOLATION §3 (a credential establishes a
-- principal and acts with that principal's own permissions), §6 (composite tenant keys),
-- 04-SECURITY-PRIVACY §3 (immediate server-side revocation), 07-DATA-MODEL §9 (index prefixes
-- lead with `organization_id`).
--
-- ## What this migration is for
--
-- Peter wants no paid AI model. Instead, an MCP server (`apps/mcp-server`) lets Claude
-- Desktop/Code, ChatGPT's developer-mode connectors, or any MCP-capable assistant connect to
-- TManage over the existing HTTP API. That server authenticates as the member who ran it by
-- presenting `Authorization: Bearer <token>`, where the token is a personal access token the
-- member created in TManage. This table is where those tokens live.
--
-- A token acts with its member's own permissions and nothing more: the Bearer path resolves
-- the token to its membership and then runs the ordinary membership-resolver and permission
-- checks, exactly as a cookie session does. There is no elevation.
--
-- ## One tenant table, membership-owned
--
-- `personal_access_tokens` belongs to one org (`organization_id` scopes every row) and to one
-- membership (`membership_id`). A composite foreign key binds `(organization_id,
-- membership_id)` to `memberships (organization_id, id)`, so a cross-tenant membership id is a
-- non-existent pair rather than a leak — the engine half of the resolve-before-write trap the
-- service also enforces. `user_id` is denormalised from that membership for the audit trail and
-- for the authentication read, and carries its own foreign key to `users`.
--
-- ## Only the hash is stored
--
-- `token_hash` is the SHA-256 hex of the plaintext, which is shown to its creator exactly once
-- and never stored — the same posture `session_refresh_tokens` (0003) takes. Lookup is by the
-- unique `token_hash` index, so the authentication path finds a token in one indexed read with
-- no tenant predicate (the member is not yet known), the way session authentication reads the
-- global `sessions` table. `token_prefix` is the safe-to-show hint (`tmanage_pat_a1b2c3…`); it
-- reverses nothing. `expires_at` is the optional creator-chosen expiry; `revoked_at` is the
-- soft revocation that 04 §3 requires be immediate — a revoked token fails its next read.
--
-- ## Immutable identity
--
-- What a token *is* — its tenant, its owning membership and user, and its secret's hash — can
-- never move; only `last_used_at` and `revoked_at` ever change after creation. The
-- `BEFORE UPDATE` trigger holds that at the engine, the way `file_comments` (0199) holds its
-- `organization_id`. The runtime credential is granted INSERT, SELECT and UPDATE (never DELETE):
-- a token is retired by setting `revoked_at`, so the row — and its audit value — survives.

CREATE TABLE personal_access_tokens (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  -- The membership the token acts as; the permission checks run against this membership's role.
  membership_id    CHAR(36)     NOT NULL,
  -- Denormalised from the membership, for the authentication read and the audit trail.
  user_id          CHAR(36)     NOT NULL,
  -- The member-chosen label shown in the Security screen, e.g. "Claude Desktop (laptop)".
  name             VARCHAR(190) NOT NULL,
  -- SHA-256 hex of the plaintext. The only form of the secret that ever reaches the database.
  token_hash       CHAR(64)     NOT NULL,
  -- The safe display hint, e.g. `tmanage_pat_a1b2c3…`; not enough to reconstruct the token.
  token_prefix     VARCHAR(32)  NOT NULL,
  last_used_at     DATETIME(3)  NULL,
  -- The optional creator-chosen expiry. NULL means the token does not expire.
  expires_at       DATETIME(3)  NULL,
  -- The soft revocation (04 §3). NULL means live; a timestamp means the token is dead.
  revoked_at       DATETIME(3)  NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_personal_access_tokens_org_id (organization_id, id),
  -- Global, tenant-free lookup on the hash — the authentication path reads by this alone.
  UNIQUE KEY uq_personal_access_tokens_hash (token_hash),
  -- The index the Security screen lists a member's own tokens by, newest-first via the UUIDv7 id.
  -- Its leading `(organization_id, membership_id)` also backs `fk_personal_access_tokens_member`.
  KEY ix_personal_access_tokens_membership (organization_id, membership_id, id),
  -- A token can only ever name a membership of its own tenant.
  CONSTRAINT fk_personal_access_tokens_member
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_personal_access_tokens_user
    FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A token's identity is immutable: its tenant, owning membership and user, and the hash of its
-- secret can never move. Only `last_used_at` and `revoked_at` change after creation.
DELIMITER $$

CREATE TRIGGER trg_personal_access_tokens_immutable
BEFORE UPDATE ON personal_access_tokens FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.membership_id <> OLD.membership_id
     OR NEW.user_id <> OLD.user_id
     OR NEW.token_hash <> OLD.token_hash THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'personal_access_tokens identity columns are immutable';
  END IF;
END$$

DELIMITER ;
