-- 0170_insight_dashboard_layouts — a member's own arrangement of the insights dashboard: which
-- metric tiles are shown, in what order, and which are hidden (module 16 Insights, INS dashboard
-- layout, x302). Mirrors home_widget_prefs (0115) for the insights surface.
--
-- Governing sources: 22-SCREEN INS insights dashboard; 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP
-- §Insights (the portfolio, delivery-flow, approval-cycle, workload, adoption, snapshot and
-- saved-view surfaces exist; a per-user tile layout for the dashboard did not); 25-AUTHORIZATION-
-- AND-TENANT-ISOLATION §6 (composite tenant keys); 07-DATA-MODEL §9 (index prefixes lead with
-- organization_id). Distinct from insight_saved_views (0089) — that stores named query views — and
-- from home_widget_prefs (0115), which arranges the Home widgets, not the insights tiles.
--
-- ## Migration number
--
-- The pass-25 queue map reserves 0170 for x302. The highest migration present on this slice's base
-- (master 5b3fcf08) is 0115; 0116-0169 are reserved by sibling pass-24/25 branches not yet
-- integrated. The migrator applies files in ascending numeric order and a gap is not an error (it
-- rejects only a NEW file numbered below an applied one), so 0170 on top of 0115 is correct on this
-- base. If the integration renumbers the reservations, the integrator renumbers this file with them.
--
-- ## One row per member, keyed by membership
--
-- A row is one membership's insights-dashboard layout, keyed `(organization_id, membership_id)` —
-- tenant-owned like `home_widget_prefs` (0115) and `a11y_preferences` (0079), registered in the
-- query guard's TENANT_TABLES. It is keyed to `membership_id`, not the global `user_id`: the layout
-- is scoped to who the caller is in this studio and never leaves the tenant, and the composite
-- foreign key binds the row to a membership of this same organization. The route has no path or
-- query that could name another membership — the acting membership comes from the authenticated
-- principal — so a caller reads and writes their own row and no other.
--
-- ## The layout is one small JSON list, stored whole
--
-- `tiles_json` is the caller's chosen tiles: an array of `{key, position, visible}` for the fixed
-- insight-metric ids. It is read and written as one, never queried across rows, so it is a JSON
-- column rather than a join table. Every key is validated against a fixed known-metric allowlist by
-- the application (`dashboard-layout.controller.ts`) — an unknown key, a duplicate key, or a
-- malformed entry is a 400 and nothing is written — the same division `home_widget_prefs.
-- widget_order_json` (0115) and `a11y_preferences.a11y_json` (0079) use. Absence of a row is the
-- default layout, so "never saved" and "saved the default layout" are one behaviour, not two.
--
-- ## The write is one upsert; identity is immutable
--
-- The repository writes `INSERT ... ON DUPLICATE KEY UPDATE` against
-- `uq_insight_dashboard_layouts_org_membership`, so a second save updates in place and a lost update
-- is not expressible. `updated_at` follows the column's `ON UPDATE`. `organization_id` and
-- `membership_id` are what a row is; the BEFORE UPDATE trigger pins them at the engine. This slice
-- grants the app INSERT and UPDATE (the upsert), no DELETE — a member clears their layout by saving
-- the default.

CREATE TABLE insight_dashboard_layouts (
  id                  CHAR(36)     NOT NULL,
  organization_id     CHAR(36)     NOT NULL,
  -- The membership whose layout this row holds. Private to it: the read and the upsert are both
  -- scoped by membership_id = the acting context's membership, so one member never sees or replaces
  -- another's layout even inside the same tenant. The composite FK below binds it to a membership
  -- of this same organization.
  membership_id       CHAR(36)     NOT NULL,
  -- The caller's chosen insight-dashboard tiles, stored whole as a JSON array of
  -- {key, position, visible}. Every key is validated against the fixed known-metric allowlist by
  -- the application; the column stores the array whole.
  tiles_json          JSON         NOT NULL,
  updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                   ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, the target of the composite FKs
  -- that bind child rows within one tenant (and the isolation corpus requires it).
  UNIQUE KEY uq_insight_dashboard_layouts_org_id (organization_id, id),
  -- One row per member. This is the upsert key: the repository writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place.
  UNIQUE KEY uq_insight_dashboard_layouts_org_membership (organization_id, membership_id),
  CONSTRAINT fk_insight_dashboard_layouts_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The membership, bound within its own tenant: the composite key refuses a membership id from
  -- outside this row's organization, so a layout can never cite a membership in another studio.
  CONSTRAINT fk_insight_dashboard_layouts_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A row's tenant and membership are what it is and are immutable; only the layout and updated_at
-- change. The trigger holds identity at the engine, the reason every other identity trigger in this
-- schema exists.
DELIMITER $$

CREATE TRIGGER trg_insight_dashboard_layouts_immutable
BEFORE UPDATE ON insight_dashboard_layouts FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'insight_dashboard_layouts.organization_id is immutable';
  END IF;
  IF NEW.membership_id <> OLD.membership_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'insight_dashboard_layouts.membership_id is immutable';
  END IF;
END$$

DELIMITER ;
