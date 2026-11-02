-- 0302_incident_register — 56-13 incident response (one-person edition), R18-f.
--
-- Governing source: 56-SECURITY-AND-TRUST-PLAN "56-13". Decision: ONE register. The plan's incident
-- register columns land on the existing GLOBAL `incidents` table (0060) instead of a second
-- `platform_incidents` table, so the public status page keeps reading the same rows. The public read
-- (`public-site/status.repository.ts`) selects its columns EXPLICITLY — id, component, status, title,
-- body, started_at, resolved_at, published, created_at — so none of the columns below can reach
-- `GET /v1/public/site/status`.
--
-- MariaDB-safe (Hostinger): plain ADD COLUMNs only — no ENUM, no generated column, no CHECK. The
-- closed vocabularies (severity, jurisdictions) are checked by the application
-- (`packages/domain/src/security/incident-clocks.ts`).
--
-- Retention: register rows are kept 5 years (the breach register); there is no purge job.
-- Registry: `incidents` is already in schema.ts TABLES and the tenant guard's NON_TENANT_TABLES;
-- scripts/db/users.sql gives the app SELECT/INSERT/UPDATE in its 0302 block.

ALTER TABLE incidents
  -- SEV0 cross-tenant or credential exposure … SEV3 minor. App-checked (`SEVERITIES`).
  ADD COLUMN severity              VARCHAR(4)   NOT NULL DEFAULT 'SEV3',
  -- When the operator became aware: every legal clock runs from here.
  ADD COLUMN detected_at           DATETIME(3)  NULL,
  ADD COLUMN contained_at          DATETIME(3)  NULL,
  -- JSON arrays of ids / labels / ISO country codes. Never shown publicly; never audited by name.
  ADD COLUMN affected_org_ids_json TEXT         NULL,
  ADD COLUMN data_categories_json  TEXT         NULL,
  -- Customer countries: which authority clocks apply (EU/EEA, SA, AE, EG).
  ADD COLUMN countries_json        TEXT         NULL,
  ADD COLUMN personal_data         TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN notified_authority_at DATETIME(3)  NULL,
  ADD COLUMN notified_customers_at DATETIME(3)  NULL,
  ADD COLUMN postmortem_url        VARCHAR(512) NULL,
  -- The platform admin's user id. No foreign key: the register outlives an account (5 years).
  ADD COLUMN created_by            CHAR(36)     NULL,
  ADD COLUMN updated_at            DATETIME(3)  NULL;
