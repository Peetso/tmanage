-- 0154_user_display_preferences — a member's own unified display preferences (module 20
-- Preferences & accessibility, PREF-DISPLAY, x285).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Preferences & accessibility;
-- 22-SCREEN PRF preferences hub; 42-INTERACTION §theme/density/RTL; 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §6 (composite tenant keys); 07-DATA-MODEL §9 (index prefixes lead with
-- organization_id). Closes the AUDIT rank-5 "unified preferences hub" gap: the theme/density/locale
-- controls were scattered or absent, and this migration is the single store that backs one hub.
--
-- ## Migration number
--
-- The pass-25 queue reserves 0154 for x285. The migrator applies files in ascending numeric order
-- and a gap is not an error (it rejects only a NEW file numbered below an applied one), so 0154 on
-- this base is correct; if the integration renumbers, the integrator renumbers this file with it and
-- nothing here depends on the literal 0154 beyond the filename.
--
-- ## One row per member per studio, keyed by membership
--
-- A row is one membership's display settings in one studio, keyed `(organization_id,
-- membership_id)` — tenant-owned like `a11y_preferences` (0079) and registered in the query guard's
-- TENANT_TABLES. It is keyed to `membership_id`, not the global `user_id`: these settings are scoped
-- to who the caller is *in this studio* and never leave the tenant, and the composite foreign key
-- binds the row to a membership of this same organization. The route has no path or query that could
-- name another membership — the acting membership comes from the authenticated principal — so a
-- caller reads and writes their own row and no other. Distinct from `a11y_preferences` (0079,
-- font/motion/contrast) and the notification digest (0117): this is the colour-mode / density /
-- locale / timezone / date-format hub.
--
-- ## display_json is the settings, stored whole
--
-- The five settings — theme (`light|dark|system`), density (`comfortable|compact`), locale
-- (BCP-47 allowlist), timezone (IANA allowlist), dateFormat (`iso|us|eu|long`) — are a small object
-- read and written as one, never queried across rows, so they are one JSON column rather than five
-- typed columns. Shape validation is the application's (`display-prefs.controller.ts`): a value off
-- any allowlist is a 400 and nothing is written, the same division `a11y_preferences.a11y_json`
-- (0079) uses. Absence of a row is the shipped defaults, so "never saved" and "saved the defaults"
-- are one behaviour, not two.
--
-- ## The write is one upsert; identity is immutable
--
-- The repository writes `INSERT ... ON DUPLICATE KEY UPDATE` against
-- `uq_user_display_preferences_org_membership`, so a second save updates in place and a lost update
-- is not expressible. `updated_at` follows the column's `ON UPDATE`. `organization_id` and
-- `membership_id` are what a row *is*; the BEFORE UPDATE trigger pins them at the engine (ADR-0001
-- layers 3 and 4 are application-side and a direct SQL session bypasses both). This slice grants the
-- app INSERT and UPDATE (the upsert), no DELETE — a member clears settings by saving the defaults.

CREATE TABLE user_display_preferences (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The membership whose settings this row holds. Private to it: the read and the upsert are both
  -- scoped by membership_id = the acting context's membership, so one member never sees or replaces
  -- another's settings even inside the same tenant. The composite FK below binds it to a membership
  -- of this same organization.
  membership_id   CHAR(36)     NOT NULL,
  -- The settings, stored whole: `{ "theme": "light|dark|system", "density": "comfortable|compact",
  -- "locale": "<bcp-47>", "timezone": "<iana>", "dateFormat": "iso|us|eu|long" }`. Shape and every
  -- allowlist are validated by the application; the column stores the object whole.
  display_json    JSON         NOT NULL,
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                               ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, the target of the composite FKs
  -- that bind child rows within one tenant (and the isolation corpus requires it).
  UNIQUE KEY uq_user_display_preferences_org_id (organization_id, id),
  -- One row per member per studio. This is the upsert key: the repository writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place.
  UNIQUE KEY uq_user_display_preferences_org_membership (organization_id, membership_id),
  CONSTRAINT fk_user_display_preferences_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The membership, bound within its own tenant: the composite key refuses a membership id from
  -- outside this row's organization, so a preference can never cite a membership in another studio.
  CONSTRAINT fk_user_display_preferences_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A row's tenant and membership are what it is and are immutable; only the settings and updated_at
-- change. The trigger holds identity at the engine, the reason every other identity trigger in this
-- schema exists.
DELIMITER $$

CREATE TRIGGER trg_user_display_preferences_immutable
BEFORE UPDATE ON user_display_preferences FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'user_display_preferences.organization_id is immutable';
  END IF;
  IF NEW.membership_id <> OLD.membership_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'user_display_preferences.membership_id is immutable';
  END IF;
END$$

DELIMITER ;
