-- 0188_insight_custom_reports — a member's own named, custom insight report: an ordered selection of
-- existing metric keys plus a layout hint, rendered against current metrics (module 15 Insights &
-- reporting, custom reports, x320).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Insights & reporting (custom reports);
-- 22-SCREEN §Insights; 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys); 07-DATA-MODEL
-- §9 (index prefixes lead with organization_id). The audit's gap: a studio can read the fixed insight
-- reports (x133–x135), save a filter preset over one (`insight_saved_views`, 0089), snapshot a
-- roll-up (0090) or set a target (0102) — but it cannot compose an *arbitrary* set of metrics into one
-- named report. This slice adds that: a report names an ordered selection of metric keys and a layout,
-- and the by-id read renders each key via the existing insights read services (composition over
-- already-built metrics — no new metric computation).
--
-- ## Migration number
--
-- The pass-26 map reserves 0188 for x320. The migrator applies files in ascending numeric order and a
-- gap is not an error (it rejects only a NEW file numbered *below* an applied one), so 0188 is correct
-- on this base; nothing here depends on the literal number beyond the filename.
--
-- ## One row per report, private to its owner in one studio
--
-- A row is one person's custom report in one studio, `(organization_id, owner_user_id)`-scoped and
-- registered in the query guard's TENANT_TABLES. Unlike `insight_saved_views` (0089) this is not a
-- filter preset over a fixed report — `metric_keys` is an ordered selection over the metric allowlist,
-- so the report composes an arbitrary metric set. The composite FK binds the row to this organization.
--
-- ## metric_keys and layout are validated by the application; metric_keys is stored whole
--
-- `metric_keys` is a JSON array of metric keys from the closed allowlist mirrored by
-- `INSIGHT_CUSTOM_REPORT_METRICS` (schema.ts); the controller rejects an empty selection or any key off
-- the allowlist with a 400 before any write, and stores the array whole (never queried across rows) —
-- the same division `insight_saved_views.filters` (0089) uses. `layout` is the closed `{list,grid}`
-- vocabulary (an ENUM, mirrored by the application allowlist); an unknown layout is a 400, never a row.
--
-- ## Create, replace and remove; identity is immutable
--
-- This slice ships create (INSERT), an idempotent replace by id (UPDATE of name/metric_keys/layout) and
-- delete (DELETE), so the app is granted INSERT, UPDATE and DELETE (scripts/db/users.sql). `updated_at`
-- follows the column's `ON UPDATE`. `organization_id` and `owner_user_id` are what a row *is*; the
-- BEFORE UPDATE trigger pins them at the engine (ADR-0001 layers 3 and 4 are application-side and a
-- direct SQL session bypasses both) — the reason every other identity trigger in this schema exists.

CREATE TABLE insight_custom_reports (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The user who owns this report. Private to them: the list, read, create, replace and delete are all
  -- scoped by owner_user_id = the acting context's user, so one member never sees or changes another's
  -- report even inside the same tenant. `owner_user_id` is the global user id, the shape
  -- `insight_saved_views` (0089) uses.
  owner_user_id   CHAR(36)     NOT NULL,
  -- The report's display name, a person's label for the composed metric set.
  name            VARCHAR(300) NOT NULL,
  -- The ordered selection of metric keys, a JSON array of allowlisted keys. The application validates
  -- each key against `INSIGHT_CUSTOM_REPORT_METRICS` and rejects an empty selection with a 400 before
  -- any write; the column stores the array whole and never queries across rows.
  metric_keys     JSON         NOT NULL,
  -- The layout hint, a closed vocabulary mirrored by the application allowlist. An unknown layout is a
  -- 400 before any write, never a stored row.
  layout          ENUM('list', 'grid') NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                               ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries (the isolation corpus requires it).
  UNIQUE KEY uq_insight_custom_reports_org_id (organization_id, id),
  -- The list index: one owner's reports in one studio, in id order.
  KEY ix_insight_custom_reports_org_owner (organization_id, owner_user_id, id),
  CONSTRAINT fk_insight_custom_reports_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A row's tenant and owner are what it is and are immutable; only name, metric_keys, layout and
-- updated_at change on a replace. The trigger holds identity at the engine, the reason every other
-- identity trigger in this schema exists.
DELIMITER $$

CREATE TRIGGER trg_insight_custom_reports_immutable
BEFORE UPDATE ON insight_custom_reports FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'insight_custom_reports.organization_id is immutable';
  END IF;
  IF NEW.owner_user_id <> OLD.owner_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'insight_custom_reports.owner_user_id is immutable';
  END IF;
END$$

DELIMITER ;
