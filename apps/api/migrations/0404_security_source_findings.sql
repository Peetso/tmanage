-- 0404_security_source_findings — the sign-in door's findings, handed from the API to the
-- worker's alert pipeline (SEC-ALERTS, 2026-11-22; incident SECURITY-INCIDENT-2026-11-21).
--
-- ## Why a hand-off table, and not a read grant for the worker
--
-- `credential_stuffing` was deferred because the worker (`tmanage_worker`) holds no read on
-- `authentication_events`, by design: that log says who signed in, from where, and which
-- addresses were probed (users.sql, least-privilege.db.test.ts). Three ways to run the rule were
-- weighed:
--
-- 1. A SELECT grant (table or columns) for the worker: rejected. Even a column grant hands the
--    relay the raw IP and the user id of every attempt, which is what D07 took away.
-- 2. A database VIEW over the failed rows: rejected. No migration creates a view; the schema
--    drift check, the tenant-isolation suite and the grant reconciliation enumerate
--    `information_schema.tables` and would all have to learn a new object kind, and a view's
--    DEFINER / SQL SECURITY behaves differently on the single-user Hostinger database.
-- 3. **Chosen:** the API, which already reads the log (database-wide SELECT, used by the sign-in
--    throttle), evaluates the rules every minute and writes only its *findings* here: a rule key,
--    a SHA-256 hash of the source address (the worker's `sourceHash` spelling), counts and a short
--    pattern label. The worker reads this table (SELECT only) and turns a finding into a
--    `security_signals` row with the existing dedupe, cooldown and mail path. The worker still
--    never sees a raw address, a user id, a user agent or a log row.
--
-- `security_source_findings` (NON_TENANT): one row per (rule, source, rule window). `count` is the
-- rule's headline number (failures, or weighted refusals); `details_json` holds the other counts
-- (TEXT, closed set of keys written by `source-findings.ts`). Pruned by the API job after 2 days:
-- the durable record is the `security_signals` row and the source log itself.
--
-- The rule rows: `credential_stuffing` is turned back on with the lane's threshold (5 failed
-- credential steps from one source in 10 minutes; the API also fires on 4 inside 10 seconds,
-- which no person typing does). Two are new: `guard_refusal_burst` (4 weighted guard refusals in
-- 10 minutes) and `sign_in_after_failures` (a success from a source that failed 3 or more
-- credential steps in the hour before it). All cool down for 60 minutes. The UPDATE only touches
-- a row still holding the 0263 seed threshold, so an operator's own saved threshold is kept.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATETIME(3), TEXT without default, no JSON type, no generated column, no CHECK,
-- no functional index. A guarded UPDATE and INSERT IGNORE: idempotent. Additive only.

CREATE TABLE security_source_findings (
  rule_key     VARCHAR(48)   NOT NULL,
  source_hash  CHAR(64)      NOT NULL,
  window_start DATETIME(3)   NOT NULL,
  count        INT           NOT NULL DEFAULT 0,
  details_json TEXT          NULL,
  first_seen   DATETIME(3)   NOT NULL,
  last_seen    DATETIME(3)   NOT NULL,
  PRIMARY KEY (rule_key, source_hash, window_start),
  KEY ix_security_source_findings_seen (last_seen)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

UPDATE platform_alert_rules
   SET enabled = 1,
       threshold_json = '{"count":5,"windowMinutes":10}',
       updated_at = CURRENT_TIMESTAMP(3)
 WHERE rule_key = 'credential_stuffing'
   AND threshold_json = '{"count":50,"windowMinutes":10}';

INSERT IGNORE INTO platform_alert_rules
  (rule_key, enabled, threshold_json, cooldown_minutes, last_fired_at, updated_by, updated_at)
VALUES
  ('credential_stuffing',  1, '{"count":5,"windowMinutes":10}', 60, NULL, NULL, CURRENT_TIMESTAMP(3)),
  ('guard_refusal_burst',  1, '{"count":4,"windowMinutes":10}', 60, NULL, NULL, CURRENT_TIMESTAMP(3)),
  ('sign_in_after_failures', 1, '{"count":3,"windowMinutes":60}', 60, NULL, NULL, CURRENT_TIMESTAMP(3));
