-- 0073_security_settings — organization security settings (Administration module 18, ADM security, x176).
--
-- Governing sources: 22-SCREEN-BY-SCREEN §Administration (security config — 2FA enforcement + IP
-- allowlist); 25-AUTHORIZATION-AND-TENANT-ISOLATION §4 ("policy may narrow, never silently widen") and
-- §6 (composite tenant keys); 07-DATA-MODEL §9 (index prefixes lead with `organization_id`); ADR-0001
-- (MySQL has no row-level security; layers 3-5 replace it, so a `BEFORE UPDATE` trigger holds identity
-- at the engine where a direct SQL session would bypass the application layers).
--
-- ## Migration number
--
-- Pass 21 reserves 0060-0080 in slice-id order; x176's reservation is 0073 (NEXT-SCOPES-13 header).
-- The migrator applies files in ascending numeric order and a legitimate gap is allowed (it rejects
-- only a NEW file numbered *below* an applied one), so 0073 on this base (master after pass 20c) is
-- correct; nothing here depends on the literal 0073 beyond the filename, and the integrator renumbers
-- with the reservations if they move.
--
-- ## What this is
--
-- The audit names Administration Partial with the security-config surface absent. This adds it: the
-- org-wide security posture, exactly one row per organization — whether a second factor is enforced
-- and an IP allowlist of permitted source networks. This slice **stores** the posture; enforcing it in
-- the auth path (refusing a login by IP, requiring a second factor) is a follow-up on the identity
-- module, deliberately separate so the config-only phase cannot lock an administrator out of their own
-- organization while they are still setting the values. What this migration guarantees is the shape at
-- rest; what the application guarantees is that the stored config is well-formed — every allowlist
-- entry is a valid IPv4/IPv6 address or CIDR range (`cidr.ts`), or the write is refused whole.
--
-- ## One row per organization; set and updated, never deleted
--
-- `uq_security_settings_org` makes a second write for the same organization an upsert target rather
-- than a second row: the controller's INSERT … ON DUPLICATE KEY UPDATE overwrites the posture in
-- place. The runtime credential is granted INSERT and UPDATE (the upsert), and **no DELETE**: a
-- posture is set and changed, never removed by a runtime credential.
--
-- ## Identity is immutable
--
-- `organization_id` and `id` are what a security-settings row *is*; the `BEFORE UPDATE` trigger holds
-- them at the engine (the reason every other identity trigger in this schema exists). Only
-- `enforce_2fa`, `ip_allowlist_json`, `updated_by` and `updated_at` move on an upsert.

CREATE TABLE security_settings (
  id                CHAR(36)     NOT NULL,
  organization_id   CHAR(36)     NOT NULL,
  -- Whether members must have a second factor enrolled. Stored intent only; enforcement is a later
  -- identity slice. TINYINT(1) is MySQL's boolean.
  enforce_2fa       TINYINT(1)   NOT NULL DEFAULT 0,
  -- The allowed source networks, a JSON array of validated IPv4/IPv6 addresses and CIDR ranges. The
  -- application (`cidr.ts`) refuses any malformed or over-count list before a write reaches here, so
  -- this column only ever holds a well-formed array; an empty array means "no restriction".
  ip_allowlist_json JSON         NOT NULL,
  -- The user who last set the posture. References users (id) without organization_id because a user is
  -- not tenant-owned — the same shape `org_settings.updated_by` (0058) uses for its actor.
  updated_by        CHAR(36)     NOT NULL,
  updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can reference
  -- this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_security_settings_org_id (organization_id, id),
  -- Exactly one row per organization: the upsert target. A second write for the same organization
  -- overwrites in place rather than inserting a second row.
  UNIQUE KEY uq_security_settings_org (organization_id),
  CONSTRAINT fk_security_settings_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_security_settings_updated_by
    FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A security-settings row's tenant and identity are immutable; only the posture (and who set it, and
-- when) move on an upsert. The trigger holds identity at the engine, the reason `org_settings`' gives.
DELIMITER $$

CREATE TRIGGER trg_security_settings_immutable
BEFORE UPDATE ON security_settings FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'security_settings.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
