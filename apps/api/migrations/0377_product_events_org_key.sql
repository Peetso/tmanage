-- 0377_product_events_org_key — the `(organization_id, id)` unique key 0251 left out.
--
-- ## What this migration is for
--
-- Every tenant-owned table carries a unique key starting with `organization_id` on
-- `(organization_id, id)` (ADR-0001 layer 1): it is what a composite tenant foreign key points at,
-- and `tenant-isolation.db.test.ts` asserts it for every table in TENANT_TABLES. 0251 created
-- `product_events` with `PRIMARY KEY (id)` and two plain indexes only, so the invariant failed
-- (found by the TESTDB lane, 2026-11-18). No table references `product_events` today; the key is
-- added so the next one that does cannot reach across tenants.
--
-- ## Safety
--
-- `id` is already the primary key, so `(organization_id, id)` is unique on every existing row and
-- the statement cannot fail on data. MariaDB 11.8 and MySQL 8 both add a secondary index online
-- (ALGORITHM=INPLACE, LOCK=NONE). Forward-only, like every migration here.

ALTER TABLE product_events
  ADD UNIQUE KEY uq_product_events_org_id (organization_id, id);
