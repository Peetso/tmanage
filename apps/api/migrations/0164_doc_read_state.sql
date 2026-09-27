-- 0164_doc_read_state — per-user document read/unread state (DOC read state, x297).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Docs and knowledge", 25-AUTHORIZATION-
-- AND-TENANT-ISOLATION-SPEC §5-6 (scoped writes, composite (organization_id, id) foreign keys),
-- 07-DATA-MODEL §9 (every composite index begins with organization_id), ADR-0001 (MySQL has no
-- row-level security; layers 3-5 replace it).
--
-- ## What this migration is for
--
-- 0030_documents shipped the document record and 0114_doc_bookmarks a member's private favorites. This
-- slice records whether a member has *read* a document: one `doc_read_state` row is the fact "this
-- membership last read this document at this instant". It powers a "new since you last looked" badge and
-- a "mark all read" affordance. Distinct from `conversation_read_state` (0122, a conversation cursor)
-- and `doc_bookmarks` (0114, a saved spot): this is the read cursor for documents.
--
-- ## Read state is per membership, and is set, refreshed, and cleared
--
-- A read-state row belongs to exactly one membership in one tenant. The writes are INSERT (first
-- mark-read), UPDATE (refresh `last_read_at` on a repeated mark-read — the upsert path), and DELETE
-- (mark-unread). `uq_doc_read_state_pin` makes a second mark-read for the same membership+document an
-- `ON DUPLICATE KEY UPDATE` that refreshes `last_read_at` in place rather than a second row, so PUT is
-- idempotent. The grant in scripts/db/users.sql withholds every other privilege.
--
-- ## Tenant-scoped, and a row can never reference another tenant's document or membership
--
-- Two composite foreign keys bind the row within one tenant: `(organization_id, doc_id)` to
-- `documents (organization_id, id)` and `(organization_id, membership_id)` to
-- `memberships (organization_id, id)`. A cross-tenant document id or membership id does not exist as
-- a pair even when both ids exist individually.

CREATE TABLE doc_read_state (
  id                CHAR(36)      NOT NULL,
  organization_id   CHAR(36)      NOT NULL,
  -- The document whose read cursor this row records. NOT NULL; the composite FK below binds it to the tenant.
  doc_id            CHAR(36)      NOT NULL,
  -- The membership whose read state this row belongs to. It is private to that membership: the batch read
  -- and the mark-unread are both scoped by membership_id = the acting context's membership, so one member
  -- never sees or clears another's read state even inside the same tenant.
  membership_id     CHAR(36)      NOT NULL,
  -- The instant the member last marked this document read. Refreshed in place by the upsert.
  last_read_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_doc_read_state_org_id (organization_id, id),
  -- Idempotency/upsert key: the same membership marking the same document read twice refreshes the one
  -- row here rather than creating a second. Leads with organization_id per 07-DATA-MODEL §9.
  UNIQUE KEY uq_doc_read_state_pin (organization_id, membership_id, doc_id),
  -- 07-DATA-MODEL §9: the batch read — a membership's read-state rows within the tenant.
  KEY ix_doc_read_state_org_membership (organization_id, membership_id),
  CONSTRAINT fk_doc_read_state_document_tenant
    FOREIGN KEY (organization_id, doc_id) REFERENCES documents (organization_id, id),
  CONSTRAINT fk_doc_read_state_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
