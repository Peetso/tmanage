-- 0156_user_startup_prefs — a member's own default startup landing view (module 20 Preferences &
-- accessibility, PREF-STARTUP, x287).
--
-- Governing sources: 22-SCREEN-INVENTORY §PRF (Preferences); 10-SCREENS-FLOWS §post-login routing;
-- 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Preferences & accessibility;
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys); 07-DATA-MODEL §9 (index prefixes
-- lead with organization_id). This lets a member pick which screen the app opens to after sign-in
-- (Home, Inbox, My Work, Calendar), read back so the shell can route there. Distinct from the Home
-- widget layout (x243, home_widget_prefs) and appearance/accessibility settings (x183): those shape
-- one screen; this chooses *which* screen loads first.
--
-- ## Migration number
--
-- The pass-25 queue map reserves 0156 for x287. The migrator applies files in ascending numeric
-- order and a gap is not an error (it rejects only a NEW file numbered *below* an applied one), so
-- 0156 is correct on this base; nothing here depends on the literal number beyond the filename.
--
-- ## One row per member per studio, keyed by membership
--
-- A row is one membership's startup preference in one studio, keyed `(organization_id,
-- membership_id)` — tenant-owned like `a11y_preferences` (0079) and `pref_quiet_hours` (0093), and
-- registered in the query guard's TENANT_TABLES. It is keyed to `membership_id`, not the global
-- `user_id`: the preference is scoped to who the caller is *in this studio* and never leaves the
-- tenant, and the composite foreign key binds the row to a membership of this same organization. The
-- route has no path or query that could name another membership — the acting membership comes from
-- the authenticated principal — so a caller reads and writes their own row and no other.
--
-- ## landing_key is one destination from a closed vocabulary
--
-- The preference is a single value: which landing destination the shell routes to on sign-in. It is
-- stored as a short `VARCHAR`, and the closed set of accepted values (home, inbox, my-work, calendar)
-- is enforced by the application (`startup-prefs.service.ts`), the same division
-- `a11y_preferences.a11y_json` and `saved_views.config` use — a value off the allowlist is a 400 and
-- nothing is written. Absence of a row is the shipped default (`home`), so "never saved" and "saved
-- home" are one behaviour, not two.
--
-- ## The write is one upsert; identity is immutable
--
-- The service writes `INSERT ... ON DUPLICATE KEY UPDATE` against
-- `uq_user_startup_prefs_org_membership`, so a second save updates in place and a lost update is not
-- expressible. `updated_at` follows the column's `ON UPDATE`. `organization_id` and `membership_id`
-- are what a row *is*; the BEFORE UPDATE trigger pins them at the engine (ADR-0001 layers 3 and 4 are
-- application-side and a direct SQL session bypasses both). This slice grants the app INSERT and
-- UPDATE (the upsert), no DELETE — a member reverts by saving the default.

CREATE TABLE user_startup_prefs (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The membership whose startup preference this row holds. Private to it: the read and the upsert
  -- are both scoped by membership_id = the acting context's membership, so one member never sees or
  -- replaces another's preference even inside the same tenant. The composite FK below binds it to a
  -- membership of this same organization.
  membership_id   CHAR(36)     NOT NULL,
  -- The chosen landing destination — one value from the application's closed vocabulary (home,
  -- inbox, my-work, calendar). Shape and membership of the allowlist are validated by the
  -- application; the column stores the accepted string. An unknown value never reaches here — the
  -- controller returns 400 and writes nothing.
  landing_key     VARCHAR(32)  NOT NULL,
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                               ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, the target of the composite FKs
  -- that bind child rows within one tenant (and the isolation corpus requires it).
  UNIQUE KEY uq_user_startup_prefs_org_id (organization_id, id),
  -- One row per member per studio. This is the upsert key: the service writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place.
  UNIQUE KEY uq_user_startup_prefs_org_membership (organization_id, membership_id),
  CONSTRAINT fk_user_startup_prefs_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The membership, bound within its own tenant: the composite key refuses a membership id from
  -- outside this row's organization, so a startup-preference row can never cite a membership in
  -- another studio.
  CONSTRAINT fk_user_startup_prefs_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A row's tenant and membership are what it is and are immutable; only the preference and updated_at
-- change. The trigger holds identity at the engine, the reason every other identity trigger in this
-- schema exists.
DELIMITER $$

CREATE TRIGGER trg_user_startup_prefs_immutable
BEFORE UPDATE ON user_startup_prefs FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'user_startup_prefs.organization_id is immutable';
  END IF;
  IF NEW.membership_id <> OLD.membership_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'user_startup_prefs.membership_id is immutable';
  END IF;
END$$

DELIMITER ;
