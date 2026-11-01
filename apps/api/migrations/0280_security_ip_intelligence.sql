-- 0280_security_ip_intelligence — R12 (R1, "locate an intruder"), slice 1.
--
-- 1. `ip_lookups` (NEW, GLOBAL): one row per IP address seen on a sign-in or a session — its
--    approximate place and network from DB-IP Lite (CC BY 4.0, a local .mmdb file), whether it is a
--    Tor exit, and whether a VPN/proxy is *possible*. A cache next to the IP, not columns on the
--    append-only events: sessions and events join on `ip`. Refreshed when `looked_up_at` is older
--    than 30 days; the worker deletes rows whose `last_seen_at` is older than GEOIP_RETENTION_DAYS
--    (default 400, the longest audit retention). No organization_id: an address belongs to nobody.
-- 2. `authentication_events` gains the sign-in's automation signal (`automation_score` 0-100,
--    `automation_reasons_json`) and the client hints it was computed from, plus
--    `ix_authentication_events_ip_occurred` for the "attempts from this address in 10 minutes"
--    count. The table stays append-only (0004's triggers refuse UPDATE/DELETE); the new columns
--    are written by the INSERT.
-- 3. `sessions.sign_in_event_id` links a session to the event of the sign-in that began it.
--
-- Grants (scripts/db/users.sql 0280 block): app SELECT, INSERT, UPDATE on `ip_lookups`; worker
-- SELECT, DELETE (the retention sweep). The new columns ride the existing table-level grants.
--
-- MariaDB 11.8 / MySQL 8 safe: no generated column, no IF NOT EXISTS, no CHECK, no expression
-- default; JSON as in 0275.

CREATE TABLE ip_lookups (
  ip VARCHAR(45) NOT NULL,
  country_code CHAR(2) NULL,
  country VARCHAR(80) NULL,
  region VARCHAR(120) NULL,
  city VARCHAR(120) NULL,
  postal_code VARCHAR(16) NULL,
  asn INT UNSIGNED NULL,
  network_owner VARCHAR(190) NULL,
  network_kind ENUM('residential', 'hosting', 'local', 'unknown') NOT NULL DEFAULT 'unknown',
  is_tor TINYINT(1) NOT NULL DEFAULT 0,
  vpn_or_proxy ENUM('likely', 'unknown') NOT NULL DEFAULT 'unknown',
  source VARCHAR(16) NULL,
  looked_up_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  PRIMARY KEY (ip),
  INDEX ix_ip_lookups_last_seen (last_seen_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE authentication_events
  ADD COLUMN automation_score TINYINT UNSIGNED NULL,
  ADD COLUMN automation_reasons_json JSON NULL,
  ADD COLUMN client_hints VARCHAR(255) NULL,
  ADD INDEX ix_authentication_events_ip_occurred (ip, occurred_at);

ALTER TABLE sessions
  ADD COLUMN sign_in_event_id CHAR(36) NULL;
