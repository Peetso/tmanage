-- 0391_plan_versions_ai_credits — the monthly AI credit allowance on the version-1 plan rows (plan 62 §5, 62-07), data only.
--
-- Plan 62 §5: the AI allowance is `limits_json.aiCreditsMonthly` in `plan_versions`, resolved like
-- storage (plan, then a support raise, then the platform cap). 1 credit = 0.001 USD of real API
-- cost. The figures are the plan's provisional ones until the Phase 0 benchmark fixes them: Free 0,
-- Starter 1,000, Studio 2,000, Business 3,000; Enterprise is "by agreement", so its row carries no
-- figure (`billing/ai-allowance.ts` then uses the per-workspace target and a platform admin's raise
-- through `organization_limits.ai_credits_limit`). They are allowances, not prices.
--
-- As in 0369, the version-1 rows are corrected in place: the ladder is off during the free beta
-- and nobody has been billed against them. Each statement writes the whole JSON value (no JSON
-- function), keyed by the fixed ids 0351 seeded, so running it twice changes nothing; every other
-- limit is written back exactly as 0369 left it. Mirrors `PLAN_LIMITS` in
-- apps/api/src/modules/billing/plan-catalog.ts.
--
-- MariaDB-safe: plain UPDATEs on existing columns; no DDL, no generated column, no JSON function.

UPDATE plan_versions
   SET limits_json = '{"people":3,"activeProjects":3,"storageBytes":1073741824,"maxFileBytes":26214400,"aiCreditsMonthly":0}'
 WHERE id = '01900000-0000-7000-8000-000000000351';

UPDATE plan_versions
   SET limits_json = '{"people":10,"activeProjects":null,"storageBytes":5368709120,"maxFileBytes":262144000,"aiCreditsMonthly":1000}'
 WHERE id = '01900000-0000-7000-8000-000000000352';

UPDATE plan_versions
   SET limits_json = '{"people":null,"activeProjects":null,"storageBytes":10737418240,"maxFileBytes":1073741824,"aiCreditsMonthly":2000}'
 WHERE id = '01900000-0000-7000-8000-000000000353';

UPDATE plan_versions
   SET limits_json = '{"people":null,"activeProjects":null,"storageBytes":26843545600,"maxFileBytes":2147483648,"aiCreditsMonthly":3000}'
 WHERE id = '01900000-0000-7000-8000-000000000354';
