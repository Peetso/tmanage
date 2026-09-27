-- 0102_insight_targets — an org's target/goal line per insights metric (module 15 Insights &
-- reporting, x230).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Insights & reporting;
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys); 07-DATA-MODEL §9 (index prefixes
-- lead with organization_id). The audit's gap: insights reports are live (x133–x135) and can be
-- snapshotted (x211) and compared (x229), but there is no target/goal line to measure a current
-- number against. This slice adds a stored org-wide target per metric, and a status read that
-- compares the live metric to it. Distinct from x210 saved-views (a saved filter), x211 snapshots
-- (a frozen roll-up) and x228 schedules (a delivery cadence): those store *what* to look at or *when*;
-- this stores the *goal* the metric is judged against.
--
-- ## Migration number
--
-- The pass-23 map reserves 0102 for x230. The migrator applies files in ascending numeric order and a
-- gap is not an error (it rejects only a NEW file numbered *below* an applied one), so 0102 is correct
-- on this base; nothing here depends on the literal number beyond the filename.
--
-- ## One row per metric per studio, keyed by metric
--
-- A row is one org-wide target for one metric, keyed `(organization_id, metric)` — tenant-owned like
-- `insight_snapshots` (0090) and registered in the query guard's TENANT_TABLES. The metric is a closed
-- vocabulary (an ENUM, mirrored by the application allowlist): an unknown metric is a 400 in the
-- controller, never a stored row. `target_value` is a bounded non-negative integer (the metrics it
-- judges are counts); `period` is the cadence the target applies to. The status read guards a zero
-- target so an attainment ratio never divides by zero.
--
-- ## The write is one upsert; identity is immutable
--
-- The service writes `INSERT ... ON DUPLICATE KEY UPDATE` against `uq_insight_targets_org_metric`, so
-- setting a metric's target a second time replaces it in place and a lost update is not expressible.
-- `updated_at` follows the column's `ON UPDATE`. `organization_id` and `metric` are what a row *is*;
-- the BEFORE UPDATE trigger pins them at the engine (ADR-0001 layers 3 and 4 are application-side and a
-- direct SQL session bypasses both). This slice grants the app INSERT and UPDATE (the upsert), no
-- DELETE — a target is set and re-set, not removed this slice.

CREATE TABLE insight_targets (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The metric this target judges. A closed vocabulary mirrored by the application allowlist in
  -- `targets.service.ts`; an unknown value is a 400 before any write, never a stored row.
  metric          ENUM('open_items', 'scheduled_items', 'active_projects', 'active_assignees')
                               NOT NULL,
  -- The goal line: a bounded non-negative count. The status read compares the live metric to it and
  -- guards a zero target so the attainment ratio never divides by zero.
  target_value    INT UNSIGNED NOT NULL,
  -- The cadence the target applies to (display/grouping only this slice).
  period          ENUM('weekly', 'monthly', 'quarterly') NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                               ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries (the isolation corpus requires it).
  UNIQUE KEY uq_insight_targets_org_id (organization_id, id),
  -- One target per metric per studio. This is the upsert key: the service writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a re-set updates in place.
  UNIQUE KEY uq_insight_targets_org_metric (organization_id, metric),
  CONSTRAINT fk_insight_targets_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A row's tenant and metric are what it is and are immutable; only the target value, period and
-- updated_at change. The trigger holds identity at the engine, the reason every other identity trigger
-- in this schema exists.
DELIMITER $$

CREATE TRIGGER trg_insight_targets_immutable
BEFORE UPDATE ON insight_targets FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'insight_targets.organization_id is immutable';
  END IF;
  IF NEW.metric <> OLD.metric THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'insight_targets.metric is immutable';
  END IF;
END$$

DELIMITER ;
