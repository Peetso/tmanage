-- 0285_platform_admin_alert_rules — R14 slice d (56-21b follow-up).
--
-- Seeds the `platform_alert_rules` rows (0263) for the four 56-21b platform admin anomaly rules,
-- with the same values the worker carries as code defaults (`apps/worker/src/jobs/
-- security-detector.ts`, PLATFORM_ADMIN_RULES), so the platform security page shows and edits
-- real rows instead of falling back to the code defaults:
--
-- - `support_sessions_burst`      — 6 support sessions by one admin in a day.
-- - `platform_access_off_hours`   — 1 platform access between 00:00 and 06:00 (admin's zone).
-- - `platform_step_up_failures`   — 3 refused step-ups (`platform.step_up_failed`) in 30 minutes;
--                                   no longer deferred (R14-d writes the platform audit row).
-- - `support_session_new_country` — 1 support session from a country new in the last 90 days.
--
-- Cooldown one day each (the worker dedupes per rule, admin and UTC day). INSERT IGNORE keeps a
-- row an operator already saved through the API. No new grant: the worker holds SELECT/UPDATE on
-- `platform_alert_rules` (users.sql, 56-23 block).
--
-- MariaDB 11.8 / MySQL 8 safe: plain INSERT IGNORE on the primary key, no DDL, idempotent.

INSERT IGNORE INTO platform_alert_rules
  (rule_key, enabled, threshold_json, cooldown_minutes, last_fired_at, updated_by, updated_at)
VALUES
  ('support_sessions_burst',      1, '{"count":6,"windowMinutes":1440}', 1440, NULL, NULL, CURRENT_TIMESTAMP(3)),
  ('platform_access_off_hours',   1, '{"count":1,"windowMinutes":1440}', 1440, NULL, NULL, CURRENT_TIMESTAMP(3)),
  ('platform_step_up_failures',   1, '{"count":3,"windowMinutes":30}',   1440, NULL, NULL, CURRENT_TIMESTAMP(3)),
  ('support_session_new_country', 1, '{"count":1,"windowMinutes":60}',   1440, NULL, NULL, CURRENT_TIMESTAMP(3));
