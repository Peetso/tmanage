-- 0266_credential_stuffing_rule_off — turn the seeded credential-stuffing alert rule off (56-23).
--
-- 0263 seeded `credential_stuffing` enabled, but the worker keeps no read on
-- `authentication_events` by design (least privilege: users.sql and
-- apps/api/test/least-privilege.db.test.ts enforce it), so the live detector logged a refused
-- read every pass. The rule is now `deferred` in the catalog (the API refuses to enable it and
-- the detector never attempts it), and this row change keeps the stored state honest. It needs an
-- API-side or narrow-view detector before it can run.
--
-- MariaDB-safe: one plain UPDATE on a primary key, idempotent, no DDL.

UPDATE platform_alert_rules
   SET enabled = 0,
       updated_at = CURRENT_TIMESTAMP(3)
 WHERE rule_key = 'credential_stuffing'
   AND enabled = 1;
