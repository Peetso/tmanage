-- 0138_project_favorites — per-member project favorites for the compact project switcher (x268).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Member home" ("compact project
-- switcher"), 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC §5-6 (scoped writes, composite
-- (organization_id, id) foreign keys), 07-DATA-MODEL §9 (every composite index begins with
-- organization_id), ADR-0001 (MySQL has no row-level security; layers 3-5 replace it).
--
-- ## What this migration is for
--
-- A member stars a project to keep it on their quick personal switcher. One `project_favorites` row
-- is the fact "this membership favorited this project". A member favorites only projects they can
-- read (the service resolves the project tenant-scoped and relation-checks BEFORE the write), and the
-- list a member reads is only their own rows, projected to projects they can still read.
--
-- ## Favorites are per membership, and are created and removed, never edited
--
-- A favorite belongs to exactly one membership in one tenant. The only writes are INSERT (star) and
-- DELETE (unstar): there is no UPDATE path in the repository and no UPDATE grant in
-- scripts/db/users.sql, so the withheld privilege is the control and no immutability trigger is
-- needed — the `doc_bookmarks` (0114) / `home_pinned_items` (0050) posture. uq_project_favorites_fav
-- makes a duplicate star a collision at the engine; the service treats that collision as success, so
-- a repeated PUT is idempotent rather than a second row, and DELETE of a missing star is a no-op 204.
--
-- ## Tenant-scoped, and a favorite can never reference another tenant's project or membership
--
-- Two composite foreign keys bind the row within one tenant: `(organization_id, project_id)` to
-- `projects (organization_id, id)` and `(organization_id, membership_id)` to
-- `memberships (organization_id, id)`. A cross-tenant project id or membership id does not exist as a
-- pair even when both ids exist individually.

CREATE TABLE project_favorites (
  id                CHAR(36)      NOT NULL,
  organization_id   CHAR(36)      NOT NULL,
  -- The project this favorite points at. NOT NULL; the composite FK below binds it to the tenant.
  project_id        CHAR(36)      NOT NULL,
  -- The membership whose favorites this row belongs to. A favorite is private to it: the list and the
  -- unstar are both scoped by membership_id = the acting context's membership, so one member never
  -- sees or removes another's favorites even inside the same tenant.
  membership_id     CHAR(36)      NOT NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_project_favorites_org_id (organization_id, id),
  -- Idempotency guard: the same membership favoriting the same project twice collides here rather
  -- than creating a second row. Leads with organization_id per 07-DATA-MODEL §9.
  UNIQUE KEY uq_project_favorites_fav (organization_id, project_id, membership_id),
  -- 07-DATA-MODEL §9: the one read that exists — a membership's favorites, newest first, id breaking
  -- ties for a total order.
  KEY ix_project_favorites_org_membership (organization_id, membership_id, created_at, id),
  CONSTRAINT fk_project_favorites_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_project_favorites_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
