-- 0114_doc_bookmarks — per-user document bookmarks / favorites (DOC bookmarks, x242).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Docs and knowledge", 25-AUTHORIZATION-
-- AND-TENANT-ISOLATION-SPEC §5-6 (scoped writes, composite (organization_id, id) foreign keys),
-- 07-DATA-MODEL §9 (every composite index begins with organization_id), ADR-0001 (MySQL has no
-- row-level security; layers 3-5 replace it).
--
-- ## What this migration is for
--
-- 0030_documents shipped the document record. This slice gives a member a private favorites list: one
-- `doc_bookmarks` row is the fact "this membership bookmarked this document". A member bookmarks only
-- documents they can read (the service resolves the document tenant-scoped and relation-checks BEFORE
-- the write), and the list a member reads is only their own rows, projected to documents they can
-- still read.
--
-- ## Bookmarks are per membership, and are created and removed, never edited
--
-- A bookmark belongs to exactly one membership in one tenant. The only writes are INSERT (bookmark)
-- and DELETE (unbookmark): there is no UPDATE path in the repository and no UPDATE grant in
-- scripts/db/users.sql, so the withheld privilege is the control and no immutability trigger is
-- needed — the home_pinned_items (0050) posture. uq_doc_bookmarks_pin makes a duplicate bookmark a
-- collision at the engine; the service treats that collision as success, so a repeated PUT is
-- idempotent rather than a second row.
--
-- ## Tenant-scoped, and a bookmark can never reference another tenant's document or membership
--
-- Two composite foreign keys bind the row within one tenant: `(organization_id, doc_id)` to
-- `documents (organization_id, id)` and `(organization_id, membership_id)` to
-- `memberships (organization_id, id)`. A cross-tenant document id or membership id does not exist as
-- a pair even when both ids exist individually.

CREATE TABLE doc_bookmarks (
  id                CHAR(36)      NOT NULL,
  organization_id   CHAR(36)      NOT NULL,
  -- The document this bookmark points at. NOT NULL; the composite FK below binds it to the tenant.
  doc_id            CHAR(36)      NOT NULL,
  -- The membership whose favorites this row belongs to. A bookmark is private to it: the list and the
  -- unbookmark are both scoped by membership_id = the acting context's membership, so one member never
  -- sees or removes another's bookmarks even inside the same tenant.
  membership_id     CHAR(36)      NOT NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_doc_bookmarks_org_id (organization_id, id),
  -- Idempotency guard: the same membership bookmarking the same document twice collides here rather
  -- than creating a second row. Leads with organization_id per 07-DATA-MODEL §9.
  UNIQUE KEY uq_doc_bookmarks_pin (organization_id, doc_id, membership_id),
  -- 07-DATA-MODEL §9: the one read that exists — a membership's bookmarks, newest first, id breaking
  -- ties for a total order.
  KEY ix_doc_bookmarks_org_membership (organization_id, membership_id, created_at, id),
  CONSTRAINT fk_doc_bookmarks_document_tenant
    FOREIGN KEY (organization_id, doc_id) REFERENCES documents (organization_id, id),
  CONSTRAINT fk_doc_bookmarks_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
