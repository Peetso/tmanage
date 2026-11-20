-- 0384_runtime_leases — DC-3 / RT-3 / AS-4 (lane K, 2026-11-20): the leader lease.
--
-- `runtime_leases` (NEW, GLOBAL): one row per singleton duty set. Today one name, `leader`: the
-- copy of the single Hostinger app that runs the in-process worker relay, the scheduled sweeps and
-- the worker's scheduled jobs. Hostinger can run two copies of the app at once after a deploy or a
-- restart (ARCH-REVIEW DC-3); every copy serves web traffic, only the lease holder runs those
-- duties, and the others retry the lease.
--
-- Protocol (apps/worker/src/common/database/runtime-lease-store.ts): the row is created once with
-- INSERT IGNORE; a copy claims or renews it with ONE conditional UPDATE
-- `WHERE name = ? AND (holder = ? OR expires_at < ?)`, so two copies can never both win; the
-- holder renews every third of the lease; a clean shutdown expires its own row so the next copy
-- takes over at once. `generation` rises on every change of holder (a fencing number, for logs
-- and diagnosis). Every time is a bound JS Date from the copy's own clock, never the server's
-- CURRENT_TIMESTAMP (all copies run on the same host, so they share one clock).
--
-- `holder` is an opaque random tag of the copy (no host name, no pid): `/healthz/deep` shows it.
-- No organization_id: a lease is about the process, never one tenant (NON_TENANT_TABLES).
--
-- Grants (scripts/db/users.sql 0384 block): worker SELECT, INSERT, UPDATE; app SELECT (rides the
-- database-wide read, for /healthz/deep).
--
-- MariaDB 11.8 / MySQL 8 safe: no generated column, no IF NOT EXISTS, no CHECK, no expression
-- default.

CREATE TABLE runtime_leases (
  name VARCHAR(64) NOT NULL,
  holder VARCHAR(64) NOT NULL DEFAULT '',
  generation BIGINT UNSIGNED NOT NULL DEFAULT 0,
  acquired_at DATETIME(3) NULL,
  renewed_at DATETIME(3) NULL,
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
