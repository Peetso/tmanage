-- 0328_connector_installations — which registered connectors a workspace has installed (54-01).
--
-- ## What this migration is for
--
-- The connector framework keeps a registry of connectors in code
-- (`connectors/connectors.catalog.ts`): each has a key, a name, an auth type (`oauth2` or
-- `api-key`), the scopes it asks for and the capabilities it gives. The company's Google Drive,
-- OneDrive and the members' calendars are registered there too, but they keep their own tables
-- (`storage_connections`, `calendar_connections`) and their own sign-in flows. This table records
-- the installs of every other connector: one row per organization and connector.
--
-- - `connector_key` is the registry key (`jira`, `github`, ...).
-- - `credential_enc` is the token vault's envelope (the same AES-256-GCM keyring as the MFA seeds
--   and the storage refresh tokens), bound to the organization and connector. Never plaintext.
-- - `credential_hint` is the last four characters, so the screen can say which key is stored.
-- - `installed_by` / `installed_at` record who installed it and when.
--
-- Uninstall deletes the row, and with it the stored credential.
--
-- TENANT: keyed `(organization_id, id)`; `(organization_id, connector_key)` is unique, which is
-- the backstop for two installs racing each other.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATETIME(3), no generated columns, no CHECK, no functional or partial indexes,
-- utf8mb4_unicode_ci. Additive only: one new table.

CREATE TABLE connector_installations (
  id                     CHAR(36)      NOT NULL,
  organization_id        CHAR(36)      NOT NULL,
  connector_key          VARCHAR(64)   NOT NULL,
  credential_enc         TEXT          NULL,
  credential_hint        VARCHAR(8)    NULL,
  installed_by           CHAR(36)      NOT NULL,
  installed_at           DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_connector_installations_org_id (organization_id, id),
  UNIQUE KEY uq_connector_installations_org_key (organization_id, connector_key)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
