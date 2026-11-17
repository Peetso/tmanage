-- 0369_plan_versions_transient_allowance — plan 57 §19.1 (57-18) and §19.3 (57-13 revised), data only.
--
-- 57-13r. TManage sells no storage: `limits_json.storageBytes` is now the TEMPORARY allowance a
-- workspace may keep on TManage before it connects Google Drive or OneDrive: Free 1 GB, Starter
-- 5 GB, Studio 10 GB, Business 25 GB. Enterprise is "by agreement", so its row carries no figure
-- (the platform cap, STORAGE_ORG_BYTES_LIMIT_BYTES, applies, and a platform admin can raise one
-- workspace through `organization_limits`). The other limits are written back unchanged.
--
-- 57-18. Security controls (IP allowlist, session policies) and the admin console, custom roles and
-- audit log with its CSV export are on EVERY plan: `security_controls` and `admin_audit` are added
-- to every plan's `features_json`.
--
-- The plan names USD version 1 as the row to correct (§19.1 "USD v1"); the ladder is off during
-- the free beta and nobody has been billed against these figures, so the version-1 rows are
-- corrected in place rather than superseded. Each statement writes the whole JSON value (no JSON
-- function), keyed by the fixed ids 0351 seeded, so running it twice changes nothing. Mirrors
-- `PLAN_LIMITS` / `PLAN_FEATURE_SET` in apps/api/src/modules/billing/plan-catalog.ts.
--
-- MariaDB-safe: plain UPDATEs on existing columns; no DDL, no generated column, no JSON function.

UPDATE plan_versions
   SET limits_json   = '{"people":3,"activeProjects":3,"storageBytes":1073741824,"maxFileBytes":26214400}',
       features_json = '["security_controls","admin_audit"]'
 WHERE id = '01900000-0000-7000-8000-000000000351';

UPDATE plan_versions
   SET limits_json   = '{"people":10,"activeProjects":null,"storageBytes":5368709120,"maxFileBytes":262144000}',
       features_json = '["requests_approvals","client_portal","security_controls","admin_audit"]'
 WHERE id = '01900000-0000-7000-8000-000000000352';

UPDATE plan_versions
   SET limits_json   = '{"people":null,"activeProjects":null,"storageBytes":10737418240,"maxFileBytes":1073741824}',
       features_json = '["requests_approvals","client_portal","docs_decisions","insights_automations","security_controls","admin_audit"]'
 WHERE id = '01900000-0000-7000-8000-000000000353';

UPDATE plan_versions
   SET limits_json   = '{"people":null,"activeProjects":null,"storageBytes":26843545600,"maxFileBytes":2147483648}',
       features_json = '["requests_approvals","client_portal","docs_decisions","insights_automations","security_controls","admin_audit"]'
 WHERE id = '01900000-0000-7000-8000-000000000354';

UPDATE plan_versions
   SET limits_json   = '{"people":null,"activeProjects":null,"maxFileBytes":5368709120}',
       features_json = '["requests_approvals","client_portal","docs_decisions","insights_automations","security_controls","admin_audit"]'
 WHERE id = '01900000-0000-7000-8000-000000000355';
