-- 0131_inbox_saved_filters — per-member named inbox filter sets (INBOX, IN-02 "All inbox", x261).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Inbox (IN-02 "All inbox" — the
-- filtered event stream with grouping); 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC §5-6 (scoped
-- writes, composite (organization_id, id) foreign keys); 07-DATA-MODEL §9 (every composite index
-- begins with organization_id); ADR-0001 (MySQL has no row-level security; layers 3-5 replace it).
--
-- ## What this migration is for
--
-- The inbox (INBOX-001) can render a filtered event stream but cannot remember a filter. This slice
-- gives a member a private, named filter set: one `inbox_saved_filters` row is the fact "this
-- membership saved this named inbox filter". The `filter_json` is the client's opaque, serialized
-- facet set (source / project / kind); the server stores and returns it verbatim and never reads
-- into it. Distinct from `saved_searches` (0092, search) and the insights saved views (saved-view,
-- insights): this is the inbox's own filter memory.
--
-- ## Per membership, created and deleted, never edited
--
-- A saved filter belongs to exactly one membership in one tenant. The only writes are INSERT (save)
-- and DELETE (remove): there is no UPDATE path in the repository and no UPDATE grant in
-- scripts/db/users.sql, so the withheld privilege is the control and no immutability trigger is
-- needed — the `home_pinned_items` (0050) / `doc_bookmarks` (0114) posture. The list a member reads
-- and the delete they issue are both scoped by `membership_id = the acting context's membership`,
-- so one member never sees or removes another's saved filters even inside the same tenant.
--
-- ## Names are unique per member, and a row can never reference another tenant's membership
--
-- `uq_inbox_saved_filters_name (organization_id, membership_id, name)` makes a second filter of the
-- same name for the same member a duplicate-key collision the service maps to 409, so a member's
-- saved-filter names stay distinct. The composite FK `(organization_id, membership_id)` to
-- `memberships (organization_id, id)` binds the row within one tenant: a cross-tenant membership id
-- does not exist as a pair even when both ids exist individually.

CREATE TABLE inbox_saved_filters (
  id                CHAR(36)      NOT NULL,
  organization_id   CHAR(36)      NOT NULL,
  -- The membership whose saved filters this row belongs to. A saved filter is private to it: the
  -- list and the delete are both scoped by membership_id = the acting context's membership, so one
  -- member never sees or removes another's saved filters even inside the same tenant.
  membership_id     CHAR(36)      NOT NULL,
  -- The member-supplied name for the filter set. Required and non-empty (the application enforces
  -- and trims it). VARCHAR(200) — a short label, not a body.
  name              VARCHAR(200)  NOT NULL,
  -- The client's serialized inbox facet set (source / project / kind), stored verbatim as an opaque
  -- string the server never reads into. The application validates it is a bounded string before the
  -- write, so the column only ever holds a small, well-formed payload.
  filter_json       TEXT          NOT NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries (25-AUTH §6).
  UNIQUE KEY uq_inbox_saved_filters_org_id (organization_id, id),
  -- Names are unique per member: the same membership saving a second filter of the same name
  -- collides here rather than creating a second row (the service maps it to 409). Leads with
  -- organization_id per 07-DATA-MODEL §9.
  UNIQUE KEY uq_inbox_saved_filters_name (organization_id, membership_id, name),
  -- 07-DATA-MODEL §9: the one read that exists — a membership's saved filters, newest first, id
  -- breaking ties for a total order.
  KEY ix_inbox_saved_filters_org_membership (organization_id, membership_id, created_at, id),
  CONSTRAINT fk_inbox_saved_filters_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_inbox_saved_filters_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
