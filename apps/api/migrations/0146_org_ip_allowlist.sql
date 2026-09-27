-- 0146_org_ip_allowlist — organization IP allowlist entries (Administration module 18, ADM security, x277).
--
-- Governing sources: 22-SCREEN-BY-SCREEN §Administration (security config); 04-SECURITY-PRIVACY;
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §4 ("policy may narrow, never silently widen") and §6
-- (composite tenant keys); 07-DATA-MODEL §9 (index prefixes lead with `organization_id`); ADR-0001
-- (MySQL has no row-level security; layers 3-5 replace it, so a `BEFORE UPDATE` trigger holds identity
-- at the engine where a direct SQL session would bypass the application layers).
--
-- ## Migration number
--
-- Pass 25 reserves 0145-0173 in slice-id order (pass25-queue header map); x277's reservation is 0146.
-- The migrator applies files in ascending numeric order and a legitimate gap is allowed (it rejects
-- only a NEW file numbered *below* an applied one), so 0146 on this base (master after pass 24, highest
-- reserved 0144) is correct; nothing here depends on the literal 0146 beyond the filename, and the
-- integrator renumbers with the reservations if they move.
--
-- ## What this is — an advisory list, distinct from the security-settings blob (0073)
--
-- `security_settings` (0073, x176) carries a single per-organization posture row whose
-- `ip_allowlist_json` column holds the org's IP allowlist as an array on one blob. This slice is a
-- separate, itemised surface: a security admin records advisory allowed IP/CIDR ranges as individual
-- rows a screen can list, add to and remove from — each with an optional human label ("Head office
-- VPN"). It is deliberately its own entry table, not an edit of the settings blob.
--
-- ## Advisory only — no request-time enforcement in this slice
--
-- This slice **records** ranges; it does not act on them. Nothing here refuses a request by source IP.
-- Wiring enforcement into the request path is a later slice, deliberately separate so recording ranges
-- cannot lock an administrator out while they are still entering them. What this migration guarantees
-- is the shape at rest; the application (`cidr.ts`) guarantees every stored `cidr` is a syntactically
-- valid IPv4/IPv6 address or CIDR block — a malformed value is refused with a 400 before it reaches
-- here, and nothing partially valid is ever stored.
--
-- ## One row per (organization, cidr); added and removed, never edited
--
-- `uq_org_ip_allowlist_org_cidr` makes a second add of the same range for the same organization a
-- 409 rather than a duplicate row (the application checks it and answers 409; the unique key is the
-- engine backstop). Entries are added and removed, never edited in place, so the runtime credential is
-- granted INSERT and DELETE and **no UPDATE**: to change a range a studio removes it and adds it again.
--
-- ## Identity is immutable
--
-- `organization_id` and `id` are what an entry *is*; the `BEFORE UPDATE` trigger holds them at the
-- engine, the reason every other identity trigger in this schema exists (ADR-0001 layers 3 and 4 are
-- application-side and a direct SQL session bypasses both). There is no UPDATE path in the app; the
-- trigger pins identity for every credential regardless.

CREATE TABLE org_ip_allowlist (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- A single allowed source network — an IPv4/IPv6 address or a `address/prefix` CIDR block. Validated
  -- and canonicalised by the application (`cidr.ts`) before it is written; a malformed value is refused
  -- with a 400 and never lands here. 49 chars fits the longest canonical form (`<45-char IPv6>/128`).
  cidr            VARCHAR(49)  NOT NULL,
  -- An optional human label (e.g. "Head office VPN"). Nullable; bounded at 120 by the app.
  label           VARCHAR(120) NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can reference
  -- this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_org_ip_allowlist_org_id (organization_id, id),
  -- One row per (organization, cidr): a repeated add is a 409, not a second row. The application
  -- de-duplicates ahead of the write; this is the engine backstop.
  UNIQUE KEY uq_org_ip_allowlist_org_cidr (organization_id, cidr),
  CONSTRAINT fk_org_ip_allowlist_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An entry's tenant and identity are immutable; there is no update endpoint in the app, but the
-- trigger pins identity for every credential regardless, the reason `security_settings`' trigger gives.
DELIMITER $$

CREATE TRIGGER trg_org_ip_allowlist_immutable
BEFORE UPDATE ON org_ip_allowlist FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'org_ip_allowlist.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
