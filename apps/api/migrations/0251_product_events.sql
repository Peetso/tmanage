-- 0251_product_events — the usability measurement sink (55-21: events, funnels, timers).
--
-- ## What this migration is for
--
-- `55-EASIEST-TO-USE-PROGRAM` §55-21. "Easier than the others" has to be measured, not claimed:
-- onboarding steps, time to first project, palette use, help views, portal "found it" timers. The
-- app records small, metadata-only product events here — no third-party analytics, nothing paid.
-- The API writes them (`POST /v1/organizations/:orgSlug/events` and its portal twin); the Platform
-- admin "Ease scoreboard" (`GET /v1/platform/ease-scoreboard`) reads weekly aggregates.
--
-- ## Privacy-minimal by construction (34-ANALYTICS §2, PDPL/GDPR)
--
-- - No content, no file name, no email, no IP, no user id. The person is `actor_hash`: an HMAC of
--   the membership id under a server-side salt and the calendar quarter, so it rotates every
--   quarter and cannot be joined across organizations or back to a user.
-- - `properties_json` carries only allowlisted keys with enum, boolean, bucket or small-count
--   values; the API's registry drops anything else before the row is written.
-- - `occurred_at` is the client's instant clamped to ±5 minutes of the server's.
-- - Retention 13 months (33 §7); the purge job is a follow-up and needs its own DELETE grant.
--
-- ## Tenant-owned (TENANT_TABLES, organization_id)
--
-- Every row belongs to one organization; the sign-up funnel's anonymous events (no organization)
-- are a follow-up with their own global table. The cross-organization scoreboard reads through
-- the audited bootstrap path with this table as its only allowlisted table, counts only, with a
-- k-anonymity floor of 5.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, literal defaults or CURRENT_TIMESTAMP(3), TEXT for the JSON properties (no JSON
-- CHECK), VARCHAR closed lists checked in TypeScript, no generated columns, no functional indexes,
-- utf8mb4_unicode_ci. No foreign key: an event sink must never block an organization's purge.

CREATE TABLE product_events (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  occurred_at     DATETIME(3)  NOT NULL,
  received_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  event_name      VARCHAR(64)  NOT NULL,
  event_version   SMALLINT     NOT NULL DEFAULT 1,
  actor_hash      CHAR(64)     NULL,
  principal_kind  VARCHAR(16)  NOT NULL,
  locale          VARCHAR(10)  NULL,
  platform        VARCHAR(16)  NOT NULL DEFAULT 'web',
  properties_json TEXT         NULL,
  PRIMARY KEY (id),
  KEY ix_product_events_name_time (event_name, occurred_at),
  KEY ix_product_events_org_time (organization_id, occurred_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
