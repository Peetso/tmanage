-- 0125_focus_blocks — a member's own protected time on the calendar: create/list/delete personal
-- focus blocks (CAL-04 "Focus block", module map §Calendar "focus blocks", x255).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Calendar (focus blocks / protected
-- time exist as a surface; no table backed them); 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC §5-6
-- (scoped writes, composite (organization_id, id) foreign keys); 07-DATA-MODEL §9 (every composite
-- index begins with organization_id).
--
-- ## Migration number
--
-- The pass-24 queue map reserves 0125 for x255. The migrator applies files in ascending numeric
-- order and a gap is not an error (it rejects only a NEW file numbered below an applied one), so
-- 0125 on top of the base is correct on this base. If the integration renumbers the reservations,
-- the integrator renumbers this file with them.
--
-- ## A focus block is one member's, and is created and removed, never edited
--
-- A `focus_blocks` row is the fact "this membership has protected `[starts_at, ends_at)` for `title`".
-- It belongs to exactly one membership in one tenant. The only writes are INSERT (create) and DELETE
-- (remove): there is no UPDATE path in the repository and no UPDATE grant in scripts/db/users.sql, so
-- the withheld privilege is the control and no immutability trigger is needed — the `doc_bookmarks`
-- (0114) / `home_pinned_items` (0050) posture. The route has no path or query that could name another
-- membership — the acting membership comes from the authenticated principal — so a member reads,
-- creates, and deletes their own blocks and no other's.
--
-- ## Self-scoped, and a block can never reference another tenant's membership
--
-- The composite foreign key `(organization_id, membership_id)` to `memberships (organization_id, id)`
-- binds the row within one tenant: a cross-tenant membership id does not exist as a pair even when
-- both ids exist individually. The DELETE resolves `(organization_id, id)` and `membership_id = the
-- acting membership` first, so a block owned by another member — or one that does not exist — is a
-- 404 with no delete. The application enforces `ends_at > starts_at` and a bounded duration (400
-- otherwise); the store holds only well-formed rows.

CREATE TABLE focus_blocks (
  id                CHAR(36)      NOT NULL,
  organization_id   CHAR(36)      NOT NULL,
  -- The membership whose protected time this row holds. A block is private to it: the list, the
  -- create, and the delete are all scoped by membership_id = the acting context's membership, so one
  -- member never sees or removes another's blocks even inside the same tenant. The composite FK below
  -- binds it to a membership of this same organization.
  membership_id     CHAR(36)      NOT NULL,
  -- The protected window, half-open [starts_at, ends_at). The application enforces ends_at > starts_at
  -- and a bounded duration before insert; the store holds only well-formed rows.
  starts_at         DATETIME(3)   NOT NULL,
  ends_at           DATETIME(3)   NOT NULL,
  -- A short human label for the block ("Deep work", "No meetings"). Non-empty, bounded by the app.
  title             VARCHAR(200)  NOT NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, the target of the composite
  -- FKs that bind child rows within one tenant (and the isolation corpus requires it).
  UNIQUE KEY uq_focus_blocks_org_id (organization_id, id),
  -- 07-DATA-MODEL §9: the read that exists — a membership's blocks in a bounded date window, ordered
  -- by start, id breaking ties for a total order. Leads with organization_id.
  KEY ix_focus_blocks_org_membership_starts (organization_id, membership_id, starts_at, id),
  CONSTRAINT fk_focus_blocks_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The membership, bound within its own tenant: the composite key refuses a membership id from
  -- outside this row's organization, so a block can never cite a membership in another studio.
  CONSTRAINT fk_focus_blocks_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
