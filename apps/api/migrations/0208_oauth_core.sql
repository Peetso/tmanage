-- 0208_oauth_core — the OAuth 2.1 authorization server inside TManage (MCP connector S7).
--
-- Governing sources: MCP-CONNECTOR-ARCHITECTURE-2026-10-20 §4.1 (OAuth AS), its data-model
-- section (oauth_clients / oauth_grants / oauth_codes / oauth_access_tokens /
-- oauth_refresh_tokens), the threat model rows B1 (stolen AT/RT, PKCE, redirect, iss) and B3
-- (cross-tenant), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys), and
-- 04-SECURITY-PRIVACY §3 (immediate server-side revocation).
--
-- ## What this migration is for
--
-- So that an AI app (Claude, ChatGPT, Cursor, …) can connect to TManage without a copied key,
-- TManage is its own OAuth 2.1 authorization server. A browser consent ("Claude wants to work
-- in Workspace X as you — Allow?") produces a grant bound to one membership, and the client
-- then exchanges short-lived opaque tokens against `https://tmanage.peetrix.com/mcp`. These
-- five tables hold the clients, grants and token material. Only hashes of secrets are stored.
--
-- ## Tenancy
--
-- `oauth_grants` names one organization and one membership, exactly as `personal_access_tokens`
-- (0202) does, so it is tenant-owned: `organization_id` scopes every row, a composite foreign
-- key binds `(organization_id, membership_id)` to `memberships`, and it carries the
-- `(organization_id, id)` key every tenant table carries. It is registered in the guard's
-- TENANT_TABLES. Its one unscoped read — resolving a presented token back to its grant, before
-- any tenant context exists — goes through `bootstrapRead` with a mandatory reason, the same
-- posture the PAT authentication read takes.
--
-- The other four tables carry no `organization_id`. They are looked up by the SHA-256 hash of a
-- secret on the public token/authorize path, before any tenant is known — global like
-- `session_refresh_tokens` and `password_reset_tokens`. They are registered in the guard's
-- NON_TENANT_TABLES, so the identity path may read and write them.
--
-- ## Only hashes, and immediate revocation
--
-- Authorization codes, access tokens and refresh tokens are stored only as the SHA-256 hex of
-- their opaque value — the plaintext is handed to the client once and never kept, the same
-- posture `session_refresh_tokens` (0003) and `personal_access_tokens` (0202) take. Because
-- tokens are opaque and checked against these rows on every request, setting `revoked_at`
-- revokes immediately (04 §3). A refresh token rotates on every use; a second use of the same
-- refresh token is reuse, which revokes the whole family (`family_id`).
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns and keys only: no generated columns, no CHECK expressions, no expression
-- defaults beyond `CURRENT_TIMESTAMP(3)`, and `JSON` only for `redirect_uris_json` (MariaDB
-- stores JSON as LONGTEXT with a json_valid check, which is portable). Every unique/index key
-- is within the 3072-byte InnoDB DYNAMIC limit for utf8mb4.

-- A registered or CIMD-published OAuth client. `client_id` is either an opaque DCR id or a
-- CIMD https URL; `kind` records which. `redirect_uris_json` is the exact allow-list the
-- authorize endpoint matches against. No client secret is ever issued (public clients only).
CREATE TABLE oauth_clients (
  id                 CHAR(36)      NOT NULL,
  -- The OAuth `client_id`: an opaque DCR id, or a CIMD document https URL.
  client_id          VARCHAR(512)  NOT NULL,
  -- `dcr` (registered via /oauth/register) or `cimd` (client-id-metadata-document URL).
  kind               VARCHAR(16)   NOT NULL,
  -- The display name shown on the consent page; plain text, control chars stripped by the app.
  name               VARCHAR(190)  NOT NULL,
  -- The exact redirect URIs, as a JSON array of strings. Matched by exact string equality.
  redirect_uris_json JSON          NOT NULL,
  -- 1 for a known/verified CIMD host (the "Verified" badge); 0 shows the "Unverified app" warning.
  verified           TINYINT(1)    NOT NULL DEFAULT 0,
  -- SHA-256 of the registering IP, for the DCR rate limit and abuse review. Never the raw IP.
  created_ip_hash    CHAR(64)      NULL,
  last_used_at       DATETIME(3)   NULL,
  created_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_oauth_clients_client_id (client_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A consented authorization: one client acting as one membership in one organization, with a
-- fixed set of scopes. Tenant-owned, like `personal_access_tokens`. Revoked by `revoked_at`.
CREATE TABLE oauth_grants (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  -- The client this grant was issued to.
  client_pk        CHAR(36)     NOT NULL,
  -- The membership the grant acts as; permission checks run against this membership's role.
  membership_id    CHAR(36)     NOT NULL,
  -- Denormalised from the membership, for the audit trail and the token-resolution read.
  user_id          CHAR(36)     NOT NULL,
  -- Space-separated consented scopes, e.g. `tmanage:read tmanage:write`.
  scopes           VARCHAR(255) NOT NULL,
  revoked_at       DATETIME(3)  NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_oauth_grants_org_id (organization_id, id),
  KEY ix_oauth_grants_membership (organization_id, membership_id, id),
  KEY ix_oauth_grants_client (client_pk),
  CONSTRAINT fk_oauth_grants_client
    FOREIGN KEY (client_pk) REFERENCES oauth_clients (id),
  CONSTRAINT fk_oauth_grants_member
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_oauth_grants_user
    FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A one-time authorization code. Keyed by the SHA-256 hex of the code value. Single use
-- (`used_at`), 60-second lifetime, and bound to the client's redirect, the PKCE challenge and
-- the resource, so a code cannot be replayed, swapped to another redirect, or used without the
-- matching verifier. Global (no organization_id): resolved by hash on the public token path.
CREATE TABLE oauth_codes (
  code_hash     CHAR(64)      NOT NULL,
  grant_id      CHAR(36)      NOT NULL,
  -- The PKCE S256 challenge (base64url of SHA-256(verifier)); the verifier is checked at token time.
  challenge     VARCHAR(128)  NOT NULL,
  -- The exact redirect the code was issued for; the token request must present the same one.
  redirect_uri  VARCHAR(2048) NOT NULL,
  -- The canonical resource/audience the code was issued for (the `/mcp` URI).
  resource      VARCHAR(512)  NOT NULL,
  expires_at    DATETIME(3)   NOT NULL,
  used_at       DATETIME(3)   NULL,
  created_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (code_hash),
  KEY ix_oauth_codes_grant (grant_id),
  CONSTRAINT fk_oauth_codes_grant
    FOREIGN KEY (grant_id) REFERENCES oauth_grants (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An opaque access token, stored only as its SHA-256 hex. 30-minute lifetime, audience-bound
-- to the canonical `/mcp` URI, and bound to its grant and token family. Global: resolved by
-- hash on every MCP request.
CREATE TABLE oauth_access_tokens (
  token_hash   CHAR(64)      NOT NULL,
  grant_id     CHAR(36)      NOT NULL,
  -- The refresh-token family this access token belongs to; reuse detection revokes the family.
  family_id    CHAR(36)      NOT NULL,
  -- The resource the token is for; the resource server rejects a token whose audience is not `/mcp`.
  audience     VARCHAR(512)  NOT NULL,
  scopes       VARCHAR(255)  NOT NULL,
  expires_at   DATETIME(3)   NOT NULL,
  revoked_at   DATETIME(3)   NULL,
  -- Reserved for a future DPoP confirmation (`cnf.jkt`); NULL in v1 (DPoP not offered yet).
  cnf_jkt      VARCHAR(255)  NULL,
  created_at   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (token_hash),
  KEY ix_oauth_access_tokens_grant (grant_id),
  KEY ix_oauth_access_tokens_family (family_id),
  CONSTRAINT fk_oauth_access_tokens_grant
    FOREIGN KEY (grant_id) REFERENCES oauth_grants (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An opaque refresh token, stored only as its SHA-256 hex. Rotates on every use: the presented
-- token is marked `used_at` and a fresh one issued. A second use of an already-used token is
-- reuse, and the whole `family_id` is revoked. 30-day idle / 90-day absolute lifetime. Global.
CREATE TABLE oauth_refresh_tokens (
  token_hash          CHAR(64)     NOT NULL,
  family_id           CHAR(36)     NOT NULL,
  grant_id            CHAR(36)     NOT NULL,
  -- The refresh token this one was rotated from; NULL for the first in a family.
  parent_hash         CHAR(64)     NULL,
  used_at             DATETIME(3)  NULL,
  -- Idle expiry: now + 30 days, refreshed on each rotation.
  expires_at          DATETIME(3)  NOT NULL,
  -- Absolute expiry: first-issue + 90 days, carried forward unchanged on rotation.
  absolute_expires_at DATETIME(3)  NOT NULL,
  revoked_at          DATETIME(3)  NULL,
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (token_hash),
  KEY ix_oauth_refresh_tokens_grant (grant_id),
  KEY ix_oauth_refresh_tokens_family (family_id),
  CONSTRAINT fk_oauth_refresh_tokens_grant
    FOREIGN KEY (grant_id) REFERENCES oauth_grants (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
