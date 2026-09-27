-- 0094_member_profiles — module 14 People & capacity: the tenant-local editable profile a
-- member's directory entry never had (x216, re-scope of BLOCKED x192).
--
-- Governing sources: 38-MODULE-MAP §People & capacity, 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC
-- §5-6 (scoped writes, composite (organization_id, …) foreign keys), 07-DATA-MODEL §9 (every
-- composite index begins with organization_id), ADR-0001 (MySQL has no row-level security; layers
-- 3-5 replace it).
--
-- ## Why this table exists
--
-- x168 built the People directory and x169 the read-only per-member profile — both pure reads over
-- memberships/users/projects. There was NO writable person store: the only editable name field was
-- `users.display_name`, which is GLOBAL (the users table carries no organization_id), so writing it
-- from an org-scoped route would let one studio's edit change how the same person appears in every
-- other studio they belong to. That cross-tenant leak is exactly why x192 was BLOCKED. This table is
-- the missing tenant-scoped store: department, bio and contact fields that belong to one membership
-- in one studio and are edited only through the org-scoped route, never touching the global users row.
--
-- ## Keyed by (organization_id, user_id), one row per member per studio
--
-- The profile is the acting membership's, resolved membership -> (organization_id, user_id) before
-- any write. `uq_member_profiles_org_user` is the upsert key: GET/PUT are idempotent against it, and
-- the composite FK binds the pair to a membership of this same tenant, so a profile can only exist
-- for someone who is actually a member here. No DELETE path (no grant in scripts/db/users.sql); the
-- only writes are INSERT and UPDATE (the upsert).

CREATE TABLE member_profiles (
  id                CHAR(36)      NOT NULL,
  organization_id   CHAR(36)      NOT NULL,
  -- The member whose profile this is. Bound to a membership of THIS tenant by the composite FK
  -- below; the pair (organization_id, user_id) is resolved from the membership before the write.
  user_id           CHAR(36)      NOT NULL,
  -- All four fields are editable, tenant-local, and NULLable (a member may have set none). Bounded
  -- lengths so an oversize value is a 400 the route refuses, never a truncated store.
  department        VARCHAR(120)  NULL,
  bio               VARCHAR(2000) NULL,
  contact_email     VARCHAR(320)  NULL,
  contact_phone     VARCHAR(40)   NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The composite key every tenant-owned table carries.
  UNIQUE KEY uq_member_profiles_org_id (organization_id, id),
  -- The upsert key: one profile per member per studio.
  UNIQUE KEY uq_member_profiles_org_user (organization_id, user_id),
  -- Tenant-scoped referential integrity: the (organization_id, user_id) pair must name a membership
  -- of this same tenant, so a profile can never be stored for a non-member or a cross-tenant user.
  CONSTRAINT fk_member_profiles_member_tenant
    FOREIGN KEY (organization_id, user_id) REFERENCES memberships (organization_id, user_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
