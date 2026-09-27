-- 0093_pref_quiet_hours — a member's own notification quiet-hours window (module 20 Preferences &
-- accessibility, PREF-QUIET, x215).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Preferences & accessibility;
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys); 07-DATA-MODEL §9 (index prefixes
-- lead with organization_id). Distinct from the per-kind notification opt-out (NOTIF, x152,
-- notification_kind_prefs): that switches individual notification *kinds*; this is a *time-window*
-- rule — a member's do-not-disturb hours — read and written whole, and evaluated against a bound
-- clock in the stored timezone.
--
-- ## Migration number
--
-- NEXT-SCOPES-14 reserves 0093 for x215 (module 20). The migrator applies files in ascending numeric
-- order and a gap is not an error (it rejects only a NEW file numbered *below* an applied one), so
-- 0093 is correct on this base; nothing here depends on the literal number beyond the filename.
--
-- ## One row per member per studio, keyed by membership
--
-- A row is one membership's quiet-hours settings in one studio, keyed `(organization_id,
-- membership_id)` — tenant-owned like `a11y_preferences` (0079) and registered in the query guard's
-- TENANT_TABLES. It is keyed to `membership_id`, not the global `user_id`: these settings are scoped
-- to who the caller is *in this studio* and never leave the tenant, and the composite foreign key
-- binds the row to a membership of this same organization. The route has no path or query that could
-- name another membership — the acting membership comes from the authenticated principal — so a
-- caller reads and writes their own row and no other.
--
-- ## quiet_json is the settings, stored whole
--
-- The settings — enabled, start/end time-of-day (`HH:MM`), IANA timezone, and the weekdays the window
-- applies to — are a small object read and written as one, never queried across rows, so they are one
-- JSON column rather than typed columns. Shape validation is the application's
-- (`quiet-hours.controller.ts`), the same division `a11y_preferences.a11y_json` (0079) and
-- `saved_views.config` (0034) use. Absence of a row is the shipped default (disabled), so "never
-- saved" and "saved disabled" are one behaviour, not two.
--
-- ## The write is one upsert; identity is immutable
--
-- The service writes `INSERT ... ON DUPLICATE KEY UPDATE` against
-- `uq_pref_quiet_hours_org_membership`, so a second save updates in place and a lost update is not
-- expressible. `updated_at` follows the column's `ON UPDATE`. `organization_id` and `membership_id`
-- are what a row *is*; the BEFORE UPDATE trigger pins them at the engine (ADR-0001 layers 3 and 4 are
-- application-side and a direct SQL session bypasses both). This slice grants the app INSERT and
-- UPDATE (the upsert), no DELETE — a member clears settings by saving disabled.

CREATE TABLE pref_quiet_hours (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The membership whose quiet-hours this row holds. Private to it: the read and the upsert are both
  -- scoped by membership_id = the acting context's membership, so one member never sees or replaces
  -- another's window even inside the same tenant. The composite FK below binds it to a membership of
  -- this same organization.
  membership_id   CHAR(36)     NOT NULL,
  -- The settings, stored whole: `{ "enabled": bool, "startTime": "HH:MM", "endTime": "HH:MM",
  -- "timezone": "IANA/Zone", "days": [0..6] }`. Shape is validated by the application; the column
  -- stores it whole. The active-window compute uses the stored timezone against a bound Date, never
  -- the database clock.
  quiet_json      JSON         NOT NULL,
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                               ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, the target of the composite FKs
  -- that bind child rows within one tenant (and the isolation corpus requires it).
  UNIQUE KEY uq_pref_quiet_hours_org_id (organization_id, id),
  -- One row per member per studio. This is the upsert key: the service writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place.
  UNIQUE KEY uq_pref_quiet_hours_org_membership (organization_id, membership_id),
  CONSTRAINT fk_pref_quiet_hours_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The membership, bound within its own tenant: the composite key refuses a membership id from
  -- outside this row's organization, so a quiet-hours row can never cite a membership in another
  -- studio.
  CONSTRAINT fk_pref_quiet_hours_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A row's tenant and membership are what it is and are immutable; only the settings and updated_at
-- change. The trigger holds identity at the engine, the reason every other identity trigger in this
-- schema exists.
DELIMITER $$

CREATE TRIGGER trg_pref_quiet_hours_immutable
BEFORE UPDATE ON pref_quiet_hours FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'pref_quiet_hours.organization_id is immutable';
  END IF;
  IF NEW.membership_id <> OLD.membership_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'pref_quiet_hours.membership_id is immutable';
  END IF;
END$$

DELIMITER ;
