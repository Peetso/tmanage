-- 0330_sso_saml — company sign-in over SAML 2.0 beside OpenID Connect (54-15).
--
-- ## What this migration is for
--
-- The company owner may pick SAML 2.0 instead of OpenID Connect for the organization's one
-- company sign-in connection (`sso_connections`, 0327). The connection keeps its allowed domains,
-- `enforce_sso` and `auto_join`, and four columns say which protocol it speaks and, for SAML, the
-- identity provider's entity ID, its HTTP-Redirect sign-in URL and its signing certificate
-- (bare base64 DER, public, so not encrypted). For a SAML connection `issuer`, `client_id` and
-- `client_secret_enc` are empty strings.
--
-- `sso_saml_requests` holds two kinds of one-time values per organization:
--
-- - `request`: the ID of every AuthnRequest sent, until its Response arrives (consumed once:
--   `consumed_at` is set) or it expires, and the ACS refuses a Response whose InResponseTo is not
--   an unconsumed, unexpired request of the same organization.
-- - `assertion`: the ID of every Assertion accepted, until its validity ends (the replay cache).
--   `uq_sso_saml_requests_value` is the backstop for two posts of one Assertion racing.
--
-- Rows past `expires_at` are deleted by the next sign-in of the same organization.
--
-- TENANT: keyed `(organization_id, id)`. Written and read only through a service context bound to
-- the organization the signed flow cookie names.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATETIME(3), no generated columns, no CHECK, no functional or partial indexes,
-- utf8mb4_unicode_ci. Additive only: one ALTER with plain ADD COLUMN clauses and one new table.

ALTER TABLE sso_connections
  ADD COLUMN protocol           VARCHAR(8)     NOT NULL DEFAULT 'oidc',
  ADD COLUMN saml_entity_id     VARCHAR(500)   NULL,
  ADD COLUMN saml_sso_url       VARCHAR(1000)  NULL,
  ADD COLUMN saml_certificate   TEXT           NULL;

CREATE TABLE sso_saml_requests (
  id                     CHAR(36)       NOT NULL,
  organization_id        CHAR(36)       NOT NULL,
  kind                   VARCHAR(16)    NOT NULL,
  saml_id                VARCHAR(255)   NOT NULL,
  expires_at             DATETIME(3)    NOT NULL,
  consumed_at            DATETIME(3)    NULL,
  created_at             DATETIME(3)    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sso_saml_requests_org_id (organization_id, id),
  UNIQUE KEY uq_sso_saml_requests_value (organization_id, kind, saml_id),
  KEY ix_sso_saml_requests_expiry (organization_id, expires_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
