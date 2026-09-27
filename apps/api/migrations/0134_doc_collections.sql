-- 0134_doc_collections — named document collections (lightweight wiki spaces) and their membership.
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Docs and knowledge" (wiki, templates),
-- DOC-01 hub, 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC §5-6 (scoped writes, composite
-- (organization_id, id) foreign keys), 07-DATA-MODEL §9 (every composite index begins with
-- organization_id), ADR-0001 (MySQL has no row-level security; layers 3-5 replace it).
--
-- ## What this migration is for
--
-- 0030_documents shipped the document record; nothing on master groups documents into named spaces. A
-- collection is that grouping: a named bag a member drops documents into (a lightweight wiki / space).
-- This slice gives a tenant both the collection definitions and their membership in ONE table, the
-- `work_item_labels` (0105) one-table posture: a row is EITHER a collection definition (its `name` is
-- set and both `collection_id` and `document_id` are NULL — the row's own `id` IS the collection id)
-- OR a membership fact "this document belongs to this collection" (its `collection_id` points at a
-- definition row's id and its `document_id` at a `documents` row, and its `name` is NULL).
--
-- ## Collections and memberships are created and removed, never edited
--
-- The only writes are INSERT (create a collection, add a document) and DELETE (remove a document): there
-- is no UPDATE path in the repository and no UPDATE grant in scripts/db/users.sql, so the withheld
-- privilege is the control and no immutability trigger is needed — the doc_bookmarks (0114) posture.
--
-- ## Tenant-scoped, and a row can never reference another tenant's document or collection
--
-- Two composite foreign keys bind a membership row within one tenant: `(organization_id, collection_id)`
-- to this table's own `(organization_id, id)` (the definition it belongs to) and `(organization_id,
-- document_id)` to `documents (organization_id, id)`. A cross-tenant collection id or document id does
-- not exist as a pair even when both ids exist individually, so a membership row can never straddle two
-- studios. Both columns are NULL on a definition row, which the FKs permit.

CREATE TABLE doc_collections (
  id                CHAR(36)      NOT NULL,
  organization_id   CHAR(36)      NOT NULL,
  -- On a membership row, the definition this row belongs to (an `id` of another row in this table).
  -- NULL on a definition row. The composite FK below binds it to the tenant.
  collection_id     CHAR(36)      NULL,
  -- On a membership row, the document that belongs to the collection. NULL on a definition row. The
  -- composite FK below binds it to the tenant.
  document_id       CHAR(36)      NULL,
  -- On a definition row, the collection's display name. NULL on a membership row. The partial-unique
  -- posture below (name is NULL for members, and MySQL allows many NULLs in a UNIQUE key) makes the
  -- name unique among definitions only.
  name              VARCHAR(200)  NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries; also the target of the
  -- self-referential membership FK below.
  UNIQUE KEY uq_doc_collections_org_id (organization_id, id),
  -- A collection name is unique within a tenant. Membership rows have name NULL and MySQL permits many
  -- NULLs in a UNIQUE key, so this constrains definitions only; a duplicate name is a 409 at the engine.
  -- Leads with organization_id per 07-DATA-MODEL §9.
  UNIQUE KEY uq_doc_collections_name (organization_id, name),
  -- Idempotency guard: the same document added to the same collection twice collides here rather than
  -- creating a second membership row. Definition rows have both columns NULL, so they never collide here.
  UNIQUE KEY uq_doc_collections_member (organization_id, collection_id, document_id),
  -- 07-DATA-MODEL §9: list a collection's member documents, id giving a total order.
  KEY ix_doc_collections_member (organization_id, collection_id, id),
  CONSTRAINT fk_doc_collections_parent_tenant
    FOREIGN KEY (organization_id, collection_id) REFERENCES doc_collections (organization_id, id),
  CONSTRAINT fk_doc_collections_document_tenant
    FOREIGN KEY (organization_id, document_id) REFERENCES documents (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
