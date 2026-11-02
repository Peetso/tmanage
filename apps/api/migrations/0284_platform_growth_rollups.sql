-- 0284_platform_growth_rollups — R13 slice 5 (57-14 Growth rollups).
--
-- `platform_growth_rollups` (NEW, GLOBAL): one number per (period, metric, dimension) — sign-ups
-- by source, the 7-day activation funnel, the 14-day service activation, time to first project,
-- cohort retention weeks 1-8, MRR from subscriptions, client approval turnaround. Written by the
-- worker's nightly growth job (`apps/worker/src/jobs/growth-rollup.ts`) as idempotent upserts on
-- the unique key; read by `GET /v1/platform/activity/growth` (platform.activity.view). Counts,
-- rates and durations only: no organization id, no actor hash, no content (PRIV-06). No
-- organization_id: a rollup is about the whole platform, never one tenant (NON_TENANT_TABLES).
-- The worker deletes rows older than 13 months.
--
-- Grants (scripts/db/users.sql 0284 block): worker SELECT, INSERT, UPDATE, DELETE; app SELECT
-- (rides the database-wide read).
--
-- MariaDB 11.8 / MySQL 8 safe: no generated column, no IF NOT EXISTS, no CHECK, no expression
-- default.

CREATE TABLE platform_growth_rollups (
  id CHAR(36) NOT NULL,
  period_kind VARCHAR(8) NOT NULL,
  period_start DATE NOT NULL,
  metric VARCHAR(48) NOT NULL,
  dimension VARCHAR(64) NOT NULL DEFAULT '',
  value_num DECIMAL(18,4) NOT NULL,
  sample_count INT NOT NULL DEFAULT 0,
  computed_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_platform_growth_rollups_key (period_kind, period_start, metric, dimension),
  INDEX ix_platform_growth_rollups_computed (computed_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
