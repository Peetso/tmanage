-- 0327_sso_connections — company sign-in over OpenID Connect, one provider per organization (54-14).
--
-- ## What this migration is for
--
-- The company owner connects the organization's identity provider: the issuer URL, the client id
-- and secret the provider issued, the e-mail domains whose people may use it, whether company
-- sign-in is required for members (`enforce_sso`) and whether a person from an allowed domain who
-- already has a TManage account joins the organization on first sign-in (`auto_join`).
--
-- - `client_secret_enc` is a FieldCipher envelope (purpose `integration_token`, owner = row id);
--   the plaintext is never stored and never read back to the browser.
-- - `allowed_domains` is a comma-separated list of lower-case domains, checked by the service.
-- - One connection per organization: `uq_sso_connections_org`.
--
-- TENANT: keyed `(organization_id, id)`. The owner reads and writes it through their own context.
-- The sign-in paths (no organization resolved yet) read it only through `bootstrapRead` with a
-- recorded reason: by e-mail domain to start a sign-in, by organization id at the callback, and
-- `enforce_sso` beside the memberships when a password sign-in is checked.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATETIME(3), no generated columns, no CHECK, no functional or partial indexes,
-- utf8mb4_unicode_ci. Additive only: one new table.

CREATE TABLE sso_connections (
  id                     CHAR(36)       NOT NULL,
  organization_id        CHAR(36)       NOT NULL,
  issuer                 VARCHAR(500)   NOT NULL,
  client_id              VARCHAR(255)   NOT NULL,
  client_secret_enc      TEXT           NOT NULL,
  allowed_domains        VARCHAR(1000)  NOT NULL,
  enforce_sso            TINYINT(1)     NOT NULL DEFAULT 0,
  auto_join              TINYINT(1)     NOT NULL DEFAULT 0,
  created_by             CHAR(36)       NOT NULL,
  created_at             DATETIME(3)    NOT NULL,
  updated_at             DATETIME(3)    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sso_connections_org_id (organization_id, id),
  UNIQUE KEY uq_sso_connections_org (organization_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
