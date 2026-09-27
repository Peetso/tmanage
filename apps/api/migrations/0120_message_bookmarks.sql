-- 0120_message_bookmarks — a member privately saves a message (CH-07 "Message actions": Save).
--
-- Governing sources: 22-SCREEN-BY-SCREEN-SPEC CH-07 (Save among the per-message actions), and a
-- "My Saved Messages" list across conversations; 12-PERMISSION-MATRIX §2 (chat is internal-only —
-- no client role holds a conversation capability); 25-AUTH-AND-TENANT-ISOLATION §6 (composite
-- tenant keys `(organization_id, id)` on every tenant table); 07-DATA-MODEL §9 (index prefixes
-- lead with `organization_id`); ADR-0001 (MySQL has no row-level security; the withheld privilege
-- and the tenant/owner predicates are the control).
--
-- ## Migration number
--
-- Pass 24 reserves 0118-0144 in slice-id order; x248's reservation is 0120 (pass24-queue header).
-- The migrator applies files in ascending numeric order and a gap on this base is legitimate (it
-- rejects only a NEW file numbered *below* an applied one), so 0120 here is correct; nothing in the
-- code depends on the literal number beyond the filename, and the integrator renumbers if it moves.
--
-- ## What this is
--
-- Distinct from `document_bookmarks` (x242): that saves a *document*; this saves a *message*. One
-- row means "this membership saved this message". It is `home_pinned_items`' posture (0050) applied
-- to a message: private to one membership, idempotent by a unique key, created and deleted only.
--
-- The row is scoped by `membership_id` = the acting context's membership, so the toggle and the
-- "My Saved Messages" list are both self-scoped and one member never sees or removes another's
-- saved messages even inside the same tenant. The composite FK binds the membership to this same
-- tenant, and the FK to `messages` binds the saved message to it — a cross-tenant message_id has no
-- referenced row and the write fails closed.
--
-- ## Grants and immutability
--
-- The runtime credential is granted INSERT and DELETE and **no UPDATE**: a saved message is created
-- (save) and deleted (unsave), never edited — the withheld UPDATE privilege is the control that
-- keeps a row's identity fixed (the `home_pinned_items`/`saved_searches` posture), so no
-- immutability trigger is needed because no credential may UPDATE the table at all.

CREATE TABLE message_bookmarks (
  id              CHAR(36)    NOT NULL,
  organization_id CHAR(36)    NOT NULL,
  -- The saved message. The composite FK below binds it to a message of this same tenant, so a
  -- cross-tenant id resolves to no row and the insert fails rather than saving a foreign message.
  message_id      CHAR(36)    NOT NULL,
  -- The membership whose saved set this row belongs to. Private to it: the toggle and the list are
  -- both scoped by membership_id = the acting context's membership, so one member never sees or
  -- removes another's saved messages even inside the same tenant.
  membership_id   CHAR(36)    NOT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The composite key every tenant-owned table carries (25-AUTH §6), so a future child can
  -- reference this row without a cross-tenant path and the isolation corpus is satisfied.
  UNIQUE KEY uq_message_bookmarks_org_id (organization_id, id),
  -- Idempotency guard turned conflict: the same membership saving the same message twice collides
  -- here rather than creating a second row, which is what makes PUT idempotent.
  UNIQUE KEY uq_message_bookmarks_bookmark (organization_id, message_id, membership_id),
  -- 07-DATA-MODEL §9: the one read that exists — a membership's saved messages, newest first, id
  -- breaking ties for a total order.
  KEY ix_message_bookmarks_org_membership (organization_id, membership_id, created_at, id),
  CONSTRAINT fk_message_bookmarks_message_tenant
    FOREIGN KEY (organization_id, message_id) REFERENCES messages (organization_id, id),
  CONSTRAINT fk_message_bookmarks_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
