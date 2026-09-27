-- 0071_custom_roles — custom roles (Administration module 18, ADM roles, x173).
--
-- Governing sources: 22-SCREEN-BY-SCREEN §Administration (roles/policies); 38-MODULE-MAP
-- §Administration (custom roles — define a role + its capability set); 12-PERMISSION-MATRIX §2 (the
-- fixed capability list a custom role draws a subset from); 25-AUTHORIZATION-AND-TENANT-ISOLATION §4
-- ("policy may narrow, never silently widen") and §6 (composite tenant keys); 07-DATA-MODEL §9 (index
-- prefixes lead with `organization_id`); ADR-0001 (MySQL has no row-level security; layers 3-5 replace
-- it, so the INSERT-only grant, not an UPDATE trigger, is the immutability control here).
--
-- ## Migration number
--
-- Pass 21 reserves 0060-0080 in slice-id order; x173's reservation is 0071 (NEXT-SCOPES-13 header).
-- The migrator applies files in ascending numeric order and a gap is legitimate (it rejects only a NEW
-- file numbered *below* an applied one), so 0071 on this base is correct; nothing here depends on the
-- literal 0071 beyond the filename, and the integrator renumbers with the reservations if they move.
--
-- ## What this is
--
-- Administration is Partial: the audit (rank #9) names roles/policies still absent. This is the
-- smallest useful unit that adds custom roles — a named role that stores a **subset of the fixed
-- capability allowlist** (`12-PERMISSION-MATRIX` §2 / `CAPABILITIES`). It adds NO new capability and
-- grants nothing beyond the caller: the controller refuses any capability string off the allowlist
-- (400) and any capability the acting principal cannot itself exercise org-wide (403), so a custom
-- role can never widen access past its author — the privilege-escalation boundary the slice exists for.
--
-- ## One row per (organization, name); created, never mutated
--
-- `uq_custom_roles_org_name` makes a duplicate name a 409 (the unique key the controller reads a
-- conflict from), not a second row. The runtime credential is granted **INSERT only** and no UPDATE
-- and no DELETE: a custom role is defined once here — editing and deleting a role are later slices with
-- their own grants and their own immutability story. The withheld UPDATE/DELETE is the immutability
-- control (no trigger needed), the same shape `onboarding_progress` (0059) and `work_forms` (0052)
-- use. `capabilities_json` stores the capability subset as a JSON array of allowlisted strings; the
-- typed meaning is the domain's `CAPABILITIES`, applied when the row is written and read.

CREATE TABLE custom_roles (
  id                CHAR(36)      NOT NULL,
  organization_id   CHAR(36)      NOT NULL,
  -- The role's display name, unique per organization (the 409 target). VARCHAR(128) is comfortably
  -- above any name the screen accepts; the controller trims and length-checks before a write reaches
  -- here.
  name              VARCHAR(128)  NOT NULL,
  -- The capability subset, a JSON array of allowlisted capability strings. Every element is validated
  -- against the fixed `CAPABILITIES` allowlist AND against what the caller may exercise before a write,
  -- so this column only ever holds allowlisted strings the author already held.
  capabilities_json TEXT          NOT NULL,
  -- The user who defined the role. References users (id) without organization_id because a user is not
  -- tenant-owned — the same shape `org_settings.updated_by` (0058) uses for its actor.
  created_by        CHAR(36)      NOT NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can reference
  -- this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_custom_roles_org_id (organization_id, id),
  -- One role per name per organization: the duplicate-name 409 target. Leads with `organization_id`
  -- per 07-DATA-MODEL §9.
  UNIQUE KEY uq_custom_roles_org_name (organization_id, name),
  CONSTRAINT fk_custom_roles_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_custom_roles_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
