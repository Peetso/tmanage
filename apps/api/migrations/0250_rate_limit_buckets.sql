-- 0250_rate_limit_buckets — durable rate limits and daily org quotas (56-05).
--
-- Governing source: 56-SECURITY-AND-TRUST-PLAN §56-05 (and §5.8 for the intake form). The old
-- limiter lives in process and forgets on every restart; these two tables keep the windows and the
-- daily counters in MariaDB, so one shared Hostinger Node app needs no Redis.
--
-- ## `rate_limit_buckets` — GLOBAL, org-less
--
-- One row per budget key per window kind: `<policy>:<kind>:<m|h>:<hash>`, where `<hash>` is an
-- HMAC of the caller's address / link token under a pepper that changes every UTC day — no raw
-- address is ever stored (KSA PDPL Art. 11, GDPR Art. 5(1)(c)). Anonymous callers have no
-- organization, so the table has none; it is registered in the tenant guard's NON_TENANT_TABLES and
-- reached only through `identityTransaction`. 52-21 (intake spam shield) and 54-04 (developer API)
-- use this same table — no second bucket table.
--
-- The counter column is `hit_count`, not the plan's `count`: `COUNT` is a function name and the
-- column is easier to read in an upsert without it. `bucket_key` is ASCII binary because the hash
-- is base64url and case matters. Rows untouched for 2 hours are swept by the API itself (hourly,
-- `ORDER BY updated_at LIMIT 5000`), which is why the app holds DELETE here and only here.
--
-- ## `org_quota_counters` — tenant-owned
--
-- Per organization, metric and UTC day (`api_calls`, `webhook_deliveries`, `public_link_views`,
-- `push_sends`); extends what `usage_counters` does for storage with per-day counters. Keyed
-- `(organization_id, id)` like every tenant table, unique on the day key so concurrent charges
-- serialise on it. INSERT/UPDATE only; old days are kept (no DELETE grant).
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns with literal defaults and CURRENT_TIMESTAMP(3), ordinary indexes, VARCHAR
-- vocabulary, no CHECK, no generated column, no functional index, no trigger. Additive only.

CREATE TABLE rate_limit_buckets (
  bucket_key   VARCHAR(190) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- The aligned start of the window the count belongs to (minute or hour boundary, UTC).
  window_start DATETIME(3)  NOT NULL,
  hit_count    INT          NOT NULL DEFAULT 0,
  updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (bucket_key),
  -- The sweep's order.
  KEY ix_rate_limit_buckets_updated (updated_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE org_quota_counters (
  id              CHAR(36)    NOT NULL,
  organization_id CHAR(36)    NOT NULL,
  metric_key      VARCHAR(40) NOT NULL,
  day_utc         DATE        NOT NULL,
  used_count      BIGINT      NOT NULL DEFAULT 0,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_org_quota_counters_org_id (organization_id, id),
  UNIQUE KEY uq_org_quota_counters_day (organization_id, metric_key, day_utc),
  CONSTRAINT fk_org_quota_counters_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
