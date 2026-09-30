-- 0180_doc_subscriptions — a member's explicit follow list over documents (DOC subscriptions, x312).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Docs and knowledge" (follow/watch),
-- 22-SCREEN §"Document view", 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC §5-6 (scoped writes, composite
-- (organization_id, id) foreign keys), 07-DATA-MODEL §9 (every composite index begins with
-- organization_id), ADR-0001 (MySQL has no row-level security; layers 3-5 replace it).
--
-- ## What this migration is for
--
-- 0030_documents shipped the document record. This slice gives a member an explicit *follow* intent:
-- one `doc_subscriptions` row is the fact "this membership subscribed to (follows) this document". It
-- is a read-side flag only — there is NO notification dispatch in this slice. A member subscribes only
-- to documents they can read (the service resolves the document tenant-scoped and relation-checks
-- BEFORE the write), and the list a member reads is only their own rows, projected to documents they
-- can still read.
--
-- ## Distinct from doc_bookmarks (0114) and doc_read_state
--
-- `doc_bookmarks` (0114) is a personal saved list; a read-state marker records the last-read position.
-- This table is neither: it is an explicit, opt-in *follow* declaration, so it is its own table with
-- its own grant and its own unique key.
--
-- ## Subscriptions are per membership, and are created and removed, never edited
--
-- A subscription belongs to exactly one membership in one tenant. The only writes are INSERT
-- (subscribe) and DELETE (unsubscribe): there is no UPDATE path in the repository and no UPDATE grant
-- in scripts/db/users.sql, so the withheld privilege is the control and no immutability trigger is
-- needed — the doc_bookmarks (0114) / home_pinned_items (0050) posture. uq_doc_subscriptions_sub makes
-- a duplicate subscription a collision at the engine; the service treats that collision as success, so
-- a repeated PUT is idempotent rather than a second row. The subscriber is always the caller: the
-- write is scoped to membership_id = the acting context's membership, never a body/param, so a member
-- can never subscribe, unsubscribe, or read another member's follows even inside the same tenant.
--
-- ## Tenant-scoped, and a subscription can never reference another tenant's document or membership
--
-- Two composite foreign keys bind the row within one tenant: `(organization_id, document_id)` to
-- `documents (organization_id, id)` and `(organization_id, membership_id)` to
-- `memberships (organization_id, id)`. A cross-tenant document id or membership id does not exist as
-- a pair even when both ids exist individually. Keyed to `membership_id`, not the global `user_id`:
-- the composite foreign key binds the row to a membership of this same organization
-- (the conversation_read_state / doc_bookmarks posture).

CREATE TABLE doc_subscriptions (
  id                CHAR(36)      NOT NULL,
  organization_id   CHAR(36)      NOT NULL,
  -- The document this subscription follows. NOT NULL; the composite FK below binds it to the tenant.
  document_id       CHAR(36)      NOT NULL,
  -- The membership whose follow list this row belongs to. A subscription is private to it: the list
  -- and the unsubscribe are both scoped by membership_id = the acting context's membership, so one
  -- member never sees or removes another's subscriptions even inside the same tenant.
  membership_id     CHAR(36)      NOT NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_doc_subscriptions_org_id (organization_id, id),
  -- Idempotency guard: the same membership subscribing to the same document twice collides here rather
  -- than creating a second row. Leads with organization_id per 07-DATA-MODEL §9.
  UNIQUE KEY uq_doc_subscriptions_sub (organization_id, document_id, membership_id),
  -- 07-DATA-MODEL §9: the one read that exists — a membership's subscriptions, newest first, id
  -- breaking ties for a total order.
  KEY ix_doc_subscriptions_org_membership (organization_id, membership_id, created_at, id),
  CONSTRAINT fk_doc_subscriptions_document_tenant
    FOREIGN KEY (organization_id, document_id) REFERENCES documents (organization_id, id),
  CONSTRAINT fk_doc_subscriptions_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
