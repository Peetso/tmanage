-- 0058_org_settings — organization settings / policy (Administration module 18, ADM settings, x153).
--
-- Governing sources: 22-SCREEN-BY-SCREEN §Administration (org settings/policy — read + update);
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §4 ("policy may narrow, never silently widen") and §6
-- (composite tenant keys); 07-DATA-MODEL §9 (index prefixes lead with `organization_id`);
-- ADR-0001 (MySQL has no row-level security; layers 3-5 replace it, so a `BEFORE UPDATE` trigger
-- holds identity at the engine where a direct SQL session would bypass the application layers).
--
-- ## Migration number
--
-- Pass 20 reserves 0042-0059 in slice-id order; x153's reservation is 0058 (NEXT-SCOPES-12 header).
-- The highest migration present on this slice's base is lower — the sibling pass-20 branches
-- (0053-0057) land on master from branches not yet integrated here. The migrator applies files in
-- ascending numeric order and a gap is legitimate (it rejects only a NEW file numbered *below* an
-- applied one), so 0058 on this base is correct; nothing here depends on the literal 0058 beyond the
-- filename, and the integrator renumbers with the reservations if they move.
--
-- ## What this is
--
-- An organization has no settings surface at rest: the audit names Administration Partial with the
-- org-settings screen absent. This is the smallest useful unit that adds one — a **fixed-key
-- allowlist** of organization-wide settings, one row per set key. The allowlist is the substance:
-- the application (`org-settings.allowlist.ts`) is the single source of which keys exist, their
-- defaults and their per-key validators, so no arbitrary key can ever be written (an off-list key is
-- a 400 with no row). A GET returns every allowlisted key with its stored value or its default; a
-- PUT upserts one key after its validator accepts the value.
--
-- The role/capability editor (ADM-03) stays OUT — it is blocked pending the permission-matrix work
-- — and so do security-policy escalations (NEXT-SCOPES-13). This table carries only the flat,
-- validated key/value settings this slice ships.
--
-- ## One row per (organization, key); set and updated, never deleted
--
-- `uq_org_settings_org_key` makes a second write to the same key an upsert target rather than a
-- second row: the controller's INSERT … ON DUPLICATE KEY UPDATE overwrites the value in place. The
-- runtime credential is granted INSERT and UPDATE (the upsert), and **no DELETE**: a setting is set
-- and changed, never removed by a runtime credential — clearing one back to its default is a later
-- slice with its own grant. `setting_value` is stored as a string; the typed meaning of each key is
-- the allowlist's, applied when the value is read and written.
--
-- ## Identity is immutable
--
-- `organization_id`, `id` and `setting_key` are what a settings row *is*; the `BEFORE UPDATE` trigger
-- holds them at the engine (the reason every other identity trigger in this schema exists). Only
-- `setting_value`, `updated_by` and `updated_at` move on an upsert.

CREATE TABLE org_settings (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The allowlisted key. `setting_key`, not `key` — `key` is a MySQL reserved word. VARCHAR(64) is
  -- comfortably above the longest key the allowlist declares. The application refuses any key not on
  -- the allowlist before a write reaches here, so this column only ever holds an allowlisted string.
  setting_key     VARCHAR(64)  NOT NULL,
  -- The value, stored as a string. Each key's typed meaning (a timezone, an integer of minutes, a
  -- boolean) and its validator live in `org-settings.allowlist.ts`; the column stores the accepted
  -- string form. VARCHAR(255) covers every allowlisted value with room to spare.
  setting_value   VARCHAR(255) NOT NULL,
  -- The user who last set this key. References users (id) without organization_id because a user is
  -- not tenant-owned — the same shape `work_forms.created_by` (0052) uses for its actor.
  updated_by      CHAR(36)     NOT NULL,
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can reference
  -- this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_org_settings_org_id (organization_id, id),
  -- One row per key per organization: the upsert target. A second set of the same key overwrites in
  -- place rather than inserting a second row. Leads with `organization_id` per 07-DATA-MODEL §9.
  UNIQUE KEY uq_org_settings_org_key (organization_id, setting_key),
  CONSTRAINT fk_org_settings_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_org_settings_updated_by
    FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A settings row's tenant, identity and key are immutable; only the value (and who set it, and when)
-- move on an upsert. The trigger holds identity at the engine, the reason `work_forms`' trigger gives.
DELIMITER $$

CREATE TRIGGER trg_org_settings_immutable
BEFORE UPDATE ON org_settings FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'org_settings.organization_id is immutable';
  END IF;
  IF NEW.setting_key <> OLD.setting_key THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'org_settings.setting_key is immutable';
  END IF;
END$$

DELIMITER ;
