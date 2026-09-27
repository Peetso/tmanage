-- 0072_org_policies — organization access policies (Administration module 18, ADM policies, x174).
--
-- Governing sources: 22-SCREEN-BY-SCREEN §Administration (access policies — read + update);
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §4 ("policy may narrow, never silently widen") and §6
-- (composite tenant keys); 07-DATA-MODEL §9 (index prefixes lead with `organization_id`);
-- ADR-0001 (MySQL has no row-level security; layers 3-5 replace it, so a `BEFORE UPDATE` trigger
-- holds identity at the engine where a direct SQL session would bypass the application layers).
--
-- ## Migration number
--
-- Pass 21 reserves 0060-0080 in slice-id order; x174's reservation is 0072 (pass21-queue header).
-- The migrator applies files in ascending numeric order and a gap is legitimate (it rejects only a
-- NEW file numbered *below* an applied one), so 0072 on this base is correct; nothing here depends on
-- the literal 0072 beyond the filename, and the integrator renumbers with the reservations if they
-- move.
--
-- ## What this is, and how it differs from org_settings (0058, x153)
--
-- x153 added `org_settings` — a flat string key/value surface for general preferences (timezone,
-- re-auth window, default project visibility), one row per key. This is the **access-policy** surface:
-- session lifetime, invite-domain allowlist, guest access. Its values are *typed and bounded* (a whole
-- number of hours, a list of domains, a boolean), so it is stored not as many string rows but as **one
-- typed JSON document per organization**. The allowlist is still the substance: the application
-- (`policies.allowlist.ts`) is the single source of which policies exist, their defaults and their
-- per-key validators, so no arbitrary key or out-of-range value can ever be written (an off-list key or
-- a bad value is a 400 with no row).
--
-- The role/capability editor (ADM-03) stays OUT — blocked pending the permission-matrix work — and so
-- do broader security-policy escalations (NEXT-SCOPES-13). This table carries only the fixed, validated
-- access-policy document this slice ships.
--
-- ## One row per organization; created and edited, never deleted
--
-- `uq_org_policies_org` makes a second write for the same organization an upsert target rather than a
-- second row: the controller's INSERT … ON DUPLICATE KEY UPDATE overwrites the document in place. The
-- runtime credential is granted INSERT and UPDATE (the upsert), and **no DELETE**: a policy document is
-- created and edited, never removed by a runtime credential.
--
-- ## Identity is immutable
--
-- `organization_id` and `id` are what a policy row *is*; the `BEFORE UPDATE` trigger holds them at the
-- engine (the reason every other identity trigger in this schema exists). Only `policy_json`,
-- `updated_by` and `updated_at` move on an upsert.

CREATE TABLE org_policies (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The typed access-policy document (session_max_hours, invite_domain_allowlist, guest_access_enabled).
  -- The application refuses any off-allowlist key or out-of-range value before a write reaches here, so
  -- this column only ever holds a validated document. JSON so the typed, bounded values are stored as
  -- their JSON forms rather than flattened to strings.
  policy_json     JSON         NOT NULL,
  -- The user who last set the policy. References users (id) without organization_id because a user is
  -- not tenant-owned — the same shape `org_settings.updated_by` (0058) uses for its actor.
  updated_by      CHAR(36)     NOT NULL,
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can reference
  -- this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_org_policies_org_id (organization_id, id),
  -- One row per organization: the upsert target. A second write for the same organization overwrites in
  -- place rather than inserting a second row. Leads with `organization_id` per 07-DATA-MODEL §9.
  UNIQUE KEY uq_org_policies_org (organization_id),
  CONSTRAINT fk_org_policies_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_org_policies_updated_by
    FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A policy row's tenant and identity are immutable; only the document (and who set it, and when) move
-- on an upsert. The trigger holds identity at the engine, the reason `org_settings`' trigger gives.
DELIMITER $$

CREATE TRIGGER trg_org_policies_immutable
BEFORE UPDATE ON org_policies FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'org_policies.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
