-- 0172_portal_announcements — a pinned announcement banner an internal staffer posts for one client
-- organization, shown inside that client's portal for an active time window (POR client portal, x304).
--
-- Governing sources: 22-SCREEN-BY-SCREEN §POR (client portal), 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP
-- §"Client Portal", 11-USER-STORIES (portal), 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC §5-6 (scoped
-- writes, composite (organization_id, id) foreign keys), 07-DATA-MODEL §9 (every composite index begins
-- with organization_id), ADR-0001 (MySQL has no row-level security; layers 3-5 replace it).
--
-- ## What this migration is for, and what it is not
--
-- This is a **pinned banner**, distinct from the built portal updates feed (0041, a post stream) and
-- from org-wide admin announcements (org_announcements, a different table with no client_id): one
-- `portal_announcements` row is the fact "this studio pinned this notice to this client's portal for
-- this window". An internal staffer with `client_member.manage` creates and removes it; the client
-- reads only their own, and only while `starts_at <= now < ends_at` (or `ends_at IS NULL`, open-ended).
--
-- ## Created and removed, never edited
--
-- The only writes are INSERT (post) and DELETE (retract): there is no UPDATE path in the repository and
-- no UPDATE grant in scripts/db/users.sql, so the withheld privilege is the control — the doc_bookmarks
-- (0114) / home_pinned_items (0050) posture, no immutability trigger needed. A DELETE is idempotent at
-- the service; the row simply ceases to exist.
--
-- ## Tenant-scoped, and an announcement can never reference another tenant's client organization
--
-- A composite foreign key binds the row within one tenant: `(organization_id, client_id)` to
-- `client_organizations (organization_id, id)`. A cross-tenant client id does not exist as a pair even
-- when both ids exist individually, so a caller in the wrong tenant cannot pin a banner to a client
-- they cannot see — the service resolves the client tenant-scoped before it authorizes (404), and this
-- key is the storage-layer backstop for the same rule.

CREATE TABLE portal_announcements (
  id                CHAR(36)      NOT NULL,
  organization_id   CHAR(36)      NOT NULL,
  -- The client organization this banner is pinned to. NOT NULL; the composite FK below binds it to the
  -- tenant, so the client read (scoped by client_id = the resource named in the path) can never surface
  -- another client's banner even inside the same tenant.
  client_id         CHAR(36)      NOT NULL,
  title             VARCHAR(300)  NOT NULL,
  body              TEXT          NOT NULL,
  -- The active window. starts_at defaults to the insert instant (a banner posted with no start is live
  -- at once); ends_at NULL means open-ended. The client read selects starts_at <= now AND (ends_at IS
  -- NULL OR ends_at > now); the service rejects ends_at <= starts_at at the edge (400, no insert).
  starts_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ends_at           DATETIME(3)   NULL,
  created_by        CHAR(36)      NOT NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_portal_announcements_org_id (organization_id, id),
  -- 07-DATA-MODEL §9: the one read that exists — one client's active banners, newest window first, id
  -- breaking ties for a total order. Leads with organization_id, then client_id.
  KEY ix_portal_announcements_org_client (organization_id, client_id, starts_at, id),
  CONSTRAINT fk_portal_announcements_client_tenant
    FOREIGN KEY (organization_id, client_id) REFERENCES client_organizations (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
