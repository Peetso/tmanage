-- 0145_org_announcements — org-wide admin announcement banners (Administration module 18, x276).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Administration" (org broadcast),
-- 22-SCREEN-BY-SCREEN §"Administration governance", 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC §5-6
-- (scoped writes, composite (organization_id, id) foreign keys), 07-DATA-MODEL §9 (every composite
-- index begins with organization_id), ADR-0001 (MySQL has no row-level security; layers 3-5 replace it).
--
-- ## What this migration is for
--
-- An org admin posts a short banner every member of the organization sees at the top of the app — a
-- title, a body, and an optional active window. One `org_announcements` row is the fact "this
-- organization is broadcasting this message". An admin (org.manage) posts and deletes; any member
-- (work.read) reads the announcements active right now. Per-member dismissal is remembered in the
-- browser (localStorage) this slice, so there is no second table and no per-member row.
--
-- ## Posted and removed, never edited
--
-- The only writes are INSERT (post) and DELETE (retract): there is no UPDATE path in the repository and
-- no UPDATE grant in scripts/db/users.sql, so the withheld privilege is the control and no immutability
-- trigger is needed — the doc_bookmarks (0114) / home_pinned_items (0050) posture. A correction is a
-- delete and a re-post, not an edit.
--
-- ## Tenant-scoped, and an announcement can never reference or be read across tenants
--
-- `organization_id` is NOT NULL and carries the `(organization_id, id)` key every tenant table holds.
-- The composite foreign key `(organization_id, created_by)` binds the author to `memberships
-- (organization_id, id)` within the one tenant, so a cross-tenant membership id does not exist as a
-- pair even when the id exists on its own. The read is scoped by organization_id and the active-now
-- window, so one studio never sees another's banners.

CREATE TABLE org_announcements (
  id                CHAR(36)      NOT NULL,
  organization_id   CHAR(36)      NOT NULL,
  -- The banner heading, always a non-empty trimmed string; the service refuses an empty title (400)
  -- before any insert, so a stored row always has a heading.
  title             VARCHAR(200)  NOT NULL,
  -- The banner body.
  body              TEXT          NOT NULL,
  -- Optional active window. NULL start = active from the beginning; NULL end = active with no end.
  -- The service refuses ends_at <= starts_at (400) before insert, so a stored window is always valid.
  starts_at         DATETIME(3)   NULL,
  ends_at           DATETIME(3)   NULL,
  -- The membership that posted the announcement. The composite FK below binds it to the tenant.
  created_by        CHAR(36)      NOT NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_org_announcements_org_id (organization_id, id),
  -- 07-DATA-MODEL §9: the one read that exists — an organization's announcements, newest first, id
  -- breaking ties for a total order. Leads with organization_id.
  KEY ix_org_announcements_org_created (organization_id, created_at, id),
  CONSTRAINT fk_org_announcements_author_tenant
    FOREIGN KEY (organization_id, created_by) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
