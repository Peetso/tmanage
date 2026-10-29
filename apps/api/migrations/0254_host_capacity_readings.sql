-- 0254_host_capacity_readings — the shared-hosting capacity budget's readings (56-32, spec 56 §12.2).
--
-- ## What this migration is for
--
-- The API process samples its own memory, event-loop lag and open sockets every 30 s
-- (`platform-admin/health/capacity-sampler.ts`) and persists one `sample` row every 5 minutes; once
-- a day at 03:30 UTC a `nightly` row also carries the inode count under the app root, the disk in
-- use, the database size and the connection count. `GET /v1/platform/health/capacity` turns the
-- latest rows into six gauges against the plan ceilings (`platform_settings.host_profile_json`)
-- and counts how many consecutive daily readings a gauge has been red — the "move to KVM" trigger.
-- `train` rows are the per-train PERF-H-02 measurement (docs/ops/hostinger-profile.md).
--
-- ## Columns
--
-- - `source` `sample | nightly | train` — closed list checked in code.
-- - `rss_mb`, `heap_mb` — `process.memoryUsage()` in MiB; `loop_lag_ms` the p95 event-loop delay.
-- - `sockets` — open TCP sockets of this process (realtime included).
-- - `inodes`, `disk_mb`, `db_mb`, `db_connections` — nightly only; NULL on a `sample` row, and NULL
--   when the reading could not be taken (an inode walk that hit its 60 s cap is NULL, never a
--   partial undercount).
--
-- ## Global (NON_TENANT_TABLES)
--
-- Readings describe the host, never an organization; no tenant data is stored here. 90-day
-- retention: the sampler purges older rows once a day.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, no generated columns, no CHECK on JSON, no functional indexes, utf8mb4_unicode_ci.
-- Additive only.

CREATE TABLE host_capacity_readings (
  id              CHAR(36)     NOT NULL,
  taken_at        DATETIME(3)  NOT NULL,
  source          VARCHAR(8)   NOT NULL,
  rss_mb          INT          NOT NULL,
  heap_mb         INT          NOT NULL,
  loop_lag_ms     INT          NOT NULL,
  sockets         INT          NULL,
  inodes          INT          NULL,
  disk_mb         INT          NULL,
  db_mb           INT          NULL,
  db_connections  INT          NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_host_capacity_readings_taken (taken_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
