-- 0337_scim_tokens — SCIM 2.0 provisioning keys (54-16).
--
-- ## What this migration is for
--
-- An organization that has company sign-in (`sso_connections`, 0327) may let its identity provider
-- create, update and deactivate members and teams over SCIM 2.0 (`/v1/scim/v2`). The provider
-- authenticates with a bearer key the company owner creates in Admin > Security. Only the key's
-- SHA-256 (hex) is stored; the key itself is shown once. A key names exactly one organization:
-- the SCIM routes find the key by its hash on `bootstrapRead(['scim_tokens', 'sso_connections'])`
-- and then work only under a service context for that organization.
--
-- Revoking a key sets `revoked_at`; a revoked key is never accepted again. `last_used_at` is
-- written at most once a minute per key.
--
-- TENANT: keyed `(organization_id, id)`; `token_hash` is unique across organizations.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATETIME(3), no generated columns, no CHECK, no functional or partial indexes,
-- utf8mb4_unicode_ci. Additive only: one new table.

CREATE TABLE scim_tokens (
  id                     CHAR(36)       NOT NULL,
  organization_id        CHAR(36)       NOT NULL,
  name                   VARCHAR(120)   NOT NULL,
  token_hash             CHAR(64)       NOT NULL,
  token_prefix           VARCHAR(32)    NOT NULL,
  created_by             CHAR(36)       NOT NULL,
  created_at             DATETIME(3)    NOT NULL,
  last_used_at           DATETIME(3)    NULL,
  revoked_at             DATETIME(3)    NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_scim_tokens_org_id (organization_id, id),
  UNIQUE KEY uq_scim_tokens_hash (token_hash),
  KEY ix_scim_tokens_org (organization_id, revoked_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
