-- 0263_security_signals — security signals, the detector's rules and batched alerts (56-23).
--
-- ## What this migration is for
--
-- A worker pass every 5 minutes (`apps/worker/src/jobs/security-detector.ts`) reads bounded,
-- indexed windows of the raw security rows (authentication_events, public_link_events,
-- rate_limit_buckets, audit_events, webhook_deliveries, platform_backup_runs,
-- platform_support_sessions, audit_heads) and turns what crosses a threshold into one
-- deduplicated row here. At most one alert e-mail per 15 minutes goes to ALERT_EMAILS through
-- `mail_queue`; an organization's owners are told about their own organization's high-severity
-- signals only.
--
-- - `security_signals` (TENANT, nullable organization) — one row per rule, scope, subject and
--   rule window. `organization_id` NULL = a platform signal (credential stuffing against the
--   sign-in door, a missed backup): owners never see those, because every org read names its
--   own `organization_id` and NULL never equals it. `scope_key` is the non-null stand-in for the
--   organization in the dedupe key (`platform` or the organization id): a UNIQUE over a NULL
--   column would never collide, and a functional index is not MariaDB-safe. `subject_key` is
--   the subject id, the source hash or `-`. Rows hold ids, counts and SHA-256 source hashes
--   only — never a raw IP, never an e-mail, never metadata values. `notify_status` pending |
--   sent | suppressed | none (closed list checked in the worker); `notified_at` is when it was
--   mailed (or suppressed by the rule's cooldown).
-- - `platform_alert_rules` (NON_TENANT) — one row per rule key: on/off, threshold
--   `{"count":n,"windowMinutes":m}` (TEXT, validated in the API), cooldown and the last time it
--   fired. Seeded below; `impossible_travel` is seeded disabled (no GeoIP database is bundled,
--   the API refuses to enable it).
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, closed lists checked in the application, DATETIME(3), no generated columns, no
-- CHECK, no JSON type or JSON defaults, no functional indexes, utf8mb4_unicode_ci. Additive only.

CREATE TABLE security_signals (
  id              CHAR(36)      NOT NULL,
  organization_id CHAR(36)      NULL,
  scope_key       VARCHAR(40)   NOT NULL,
  rule_key        VARCHAR(48)   NOT NULL,
  severity        VARCHAR(16)   NOT NULL,
  subject_type    VARCHAR(32)   NOT NULL,
  subject_id      CHAR(36)      NULL,
  subject_key     VARCHAR(64)   NOT NULL,
  source_hash     CHAR(64)      NULL,
  count           INT           NOT NULL DEFAULT 0,
  window_start    DATETIME(3)   NOT NULL,
  first_seen      DATETIME(3)   NOT NULL,
  last_seen       DATETIME(3)   NOT NULL,
  notify_status   VARCHAR(16)   NOT NULL DEFAULT 'pending',
  notified_at     DATETIME(3)   NULL,
  details_json    TEXT          NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_security_signals_dedupe (scope_key, rule_key, subject_key, window_start),
  UNIQUE KEY uq_security_signals_org_id (organization_id, id),
  KEY ix_security_signals_org_seen (organization_id, last_seen),
  KEY ix_security_signals_notify (notify_status, first_seen),
  KEY ix_security_signals_seen (last_seen)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE platform_alert_rules (
  rule_key         VARCHAR(48)   NOT NULL,
  enabled          TINYINT(1)    NOT NULL DEFAULT 1,
  threshold_json   TEXT          NOT NULL,
  cooldown_minutes INT           NOT NULL DEFAULT 60,
  last_fired_at    DATETIME(3)   NULL,
  updated_by       CHAR(36)      NULL,
  updated_at       DATETIME(3)   NOT NULL,
  PRIMARY KEY (rule_key)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO platform_alert_rules
  (rule_key, enabled, threshold_json, cooldown_minutes, last_fired_at, updated_by, updated_at)
VALUES
  ('credential_stuffing',    1, '{"count":50,"windowMinutes":10}',   60,   NULL, NULL, CURRENT_TIMESTAMP(3)),
  ('public_link_guessing',   1, '{"count":100,"windowMinutes":60}',  60,   NULL, NULL, CURRENT_TIMESTAMP(3)),
  ('rate_limit_saturation',  1, '{"count":500,"windowMinutes":60}',  60,   NULL, NULL, CURRENT_TIMESTAMP(3)),
  ('invitation_burst',       1, '{"count":50,"windowMinutes":60}',   120,  NULL, NULL, CURRENT_TIMESTAMP(3)),
  ('permission_churn',       1, '{"count":10,"windowMinutes":60}',   120,  NULL, NULL, CURRENT_TIMESTAMP(3)),
  ('mass_export',            1, '{"count":3,"windowMinutes":60}',    120,  NULL, NULL, CURRENT_TIMESTAMP(3)),
  ('webhook_breaker',        1, '{"count":20,"windowMinutes":60}',   240,  NULL, NULL, CURRENT_TIMESTAMP(3)),
  ('backup_missed',          1, '{"count":1,"windowMinutes":1560}',  720,  NULL, NULL, CURRENT_TIMESTAMP(3)),
  ('audit_chain_break',      1, '{"count":1,"windowMinutes":10}',    60,   NULL, NULL, CURRENT_TIMESTAMP(3)),
  ('support_session_long',   1, '{"count":1,"windowMinutes":120}',   240,  NULL, NULL, CURRENT_TIMESTAMP(3)),
  ('impossible_travel',      0, '{"count":1,"windowMinutes":60}',    60,   NULL, NULL, CURRENT_TIMESTAMP(3));
