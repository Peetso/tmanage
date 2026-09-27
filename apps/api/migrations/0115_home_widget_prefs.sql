-- 0115_home_widget_prefs — a member's own Home widget layout: the order they want the My Day
-- widgets in and the ones they hide (module 4 Home / My Day, HOME widget prefs, x243).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Home / My Day (the pulse, My Day,
-- waiting and pins surfaces exist; a per-user widget layout/visibility did not); 25-AUTHORIZATION-
-- AND-TENANT-ISOLATION §6 (composite tenant keys); 07-DATA-MODEL §9 (index prefixes lead with
-- organization_id). Distinct from the x0-era home pins (0050): that stores pinned targets, this
-- stores how the caller arranges and hides the fixed Home widgets.
--
-- ## Migration number
--
-- The pass-23 queue map reserves 0115 for x243. The highest migration present on this slice's base
-- (master cca6d07) is 0080; 0081-0114 are reserved by sibling pass-19..23 branches not yet
-- integrated. The migrator applies files in ascending numeric order and a gap is not an error (it
-- rejects only a NEW file numbered below an applied one), so 0115 on top of 0080 is correct on this
-- base. If the integration renumbers the reservations, the integrator renumbers this file with them.
--
-- ## One row per member per studio, keyed by membership
--
-- A row is one membership's Home widget layout in one studio, keyed `(organization_id,
-- membership_id)` — tenant-owned like `home_pinned_items` (0050) and `a11y_preferences` (0079),
-- registered in the query guard's TENANT_TABLES. It is keyed to `membership_id`, not the global
-- `user_id`: the layout is scoped to who the caller is in this studio and never leaves the tenant,
-- and the composite foreign key binds the row to a membership of this same organization. The route
-- has no path or query that could name another membership — the acting membership comes from the
-- authenticated principal — so a caller reads and writes their own row and no other.
--
-- ## The layout is two small JSON lists, stored whole
--
-- `widget_order_json` is the caller's chosen order of the fixed Home-widget ids; `hidden_widgets_json`
-- is the ids they have hidden. Both are small ordered/unordered lists read and written as one, never
-- queried across rows, so they are JSON columns rather than a join table. Every id is validated
-- against a fixed allowlist by the application (`widget-prefs.controller.ts`) — an unknown id is a
-- 400 and nothing is written — the same division `work_forms.fields_json` (0052) and
-- `a11y_preferences.a11y_json` (0079) use. Absence of a row is the default layout, so "never saved"
-- and "saved the default layout" are one behaviour, not two.
--
-- ## The write is one upsert; identity is immutable
--
-- The repository writes `INSERT ... ON DUPLICATE KEY UPDATE` against
-- `uq_home_widget_prefs_org_membership`, so a second save updates in place and a lost update is not
-- expressible. `updated_at` follows the column's `ON UPDATE`. `organization_id` and `membership_id`
-- are what a row is; the BEFORE UPDATE trigger pins them at the engine. This slice grants the app
-- INSERT and UPDATE (the upsert), no DELETE — a member clears their layout by saving the default.

CREATE TABLE home_widget_prefs (
  id                  CHAR(36)     NOT NULL,
  organization_id     CHAR(36)     NOT NULL,
  -- The membership whose layout this row holds. Private to it: the read and the upsert are both
  -- scoped by membership_id = the acting context's membership, so one member never sees or replaces
  -- another's layout even inside the same tenant. The composite FK below binds it to a membership
  -- of this same organization.
  membership_id       CHAR(36)     NOT NULL,
  -- The caller's chosen order of the fixed Home-widget ids, stored whole as a JSON array of strings.
  -- Every id is validated against the fixed allowlist by the application; the column stores it whole.
  widget_order_json   JSON         NOT NULL,
  -- The Home-widget ids the caller has hidden, stored whole as a JSON array of strings.
  hidden_widgets_json JSON         NOT NULL,
  updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                   ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, the target of the composite FKs
  -- that bind child rows within one tenant (and the isolation corpus requires it).
  UNIQUE KEY uq_home_widget_prefs_org_id (organization_id, id),
  -- One row per member per studio. This is the upsert key: the repository writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place.
  UNIQUE KEY uq_home_widget_prefs_org_membership (organization_id, membership_id),
  CONSTRAINT fk_home_widget_prefs_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The membership, bound within its own tenant: the composite key refuses a membership id from
  -- outside this row's organization, so a layout can never cite a membership in another studio.
  CONSTRAINT fk_home_widget_prefs_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A row's tenant and membership are what it is and are immutable; only the layout and updated_at
-- change. The trigger holds identity at the engine, the reason every other identity trigger in this
-- schema exists.
DELIMITER $$

CREATE TRIGGER trg_home_widget_prefs_immutable
BEFORE UPDATE ON home_widget_prefs FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'home_widget_prefs.organization_id is immutable';
  END IF;
  IF NEW.membership_id <> OLD.membership_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'home_widget_prefs.membership_id is immutable';
  END IF;
END$$

DELIMITER ;
