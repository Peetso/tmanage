-- 0130_inbox_flags — a member's own "important" flag (star) on an inbox bundle (INBOX-001 IN-01
-- "Important inbox", module 4 Inbox, x260).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Inbox (the bundle inbox exists; a
-- per-member star / "Important" view did not); 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC §5-6
-- (scoped writes, composite (organization_id, id) foreign keys); 07-DATA-MODEL §9 (every composite
-- index begins with organization_id); ADR-0001 (MySQL has no row-level security; layers 3-5 replace
-- it).
--
-- ## What this migration is for
--
-- 0010_notifications shipped the notification rows the inbox bundles by object. This slice gives a
-- member a private "Important" list: one `inbox_flags` row is the fact "this membership starred this
-- inbox bundle". A member flags only a bundle they can see — the service re-checks ownership against
-- the caller's own notification rows (NOTIF-001's recipient-only rule) BEFORE the write, a 404 when
-- the bundle is not theirs — and the list a member reads is only their own rows.
--
-- ## The subject is `bundle_id`, the inbox's own object key, stored whole
--
-- `bundle_id` is the inbox's `objectType:objectId` (e.g. `work_item:<uuid>`), the exact id "mark
-- read" already takes. It is a synthetic, polymorphic key — a bundle is a work item or a client
-- request — so it carries no foreign key of its own, the same envelope posture `notifications.object_id`
-- (0010) takes; the tenant and membership foreign keys below are what bind the row, and the ownership
-- gate is the recipient-scoped notification read the service performs.
--
-- ## Flags are per membership, and are created and removed, never edited
--
-- A flag belongs to exactly one membership in one tenant. The only writes are INSERT (flag) and DELETE
-- (unflag): there is no UPDATE path in the repository and no UPDATE grant in scripts/db/users.sql, so
-- the withheld privilege is the control and no immutability trigger is needed — the home_pinned_items
-- (0050) and doc_bookmarks (0114) posture. uq_inbox_flags_org_membership_bundle makes a duplicate flag
-- a collision at the engine; the service treats that collision as success, so a repeated PUT is
-- idempotent rather than a second row.
--
-- ## Tenant-scoped, and a flag can never reference another tenant's membership
--
-- The composite foreign key `(organization_id, membership_id)` to `memberships (organization_id, id)`
-- binds the row within one tenant; a cross-tenant membership id does not exist as a pair even when
-- both ids exist individually. `bundle_id` is scoped by the same membership and re-authorized on
-- write, so a flag is only ever a member's own star on a bundle they may see.

CREATE TABLE inbox_flags (
  id                CHAR(36)      NOT NULL,
  organization_id   CHAR(36)      NOT NULL,
  -- The membership whose "Important" list this row belongs to. A flag is private to it: the list and
  -- the unflag are both scoped by membership_id = the acting context's membership, so one member never
  -- sees or removes another's flags even inside the same tenant.
  membership_id     CHAR(36)      NOT NULL,
  -- The inbox bundle this flag stars: the inbox's own `objectType:objectId` key, stored whole. A
  -- polymorphic, synthetic key (work item or client request), so no foreign key of its own — the same
  -- envelope posture notifications.object_id takes; the service re-checks ownership on write.
  bundle_id         VARCHAR(128)  NOT NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries (the isolation corpus requires
  -- it and the composite foreign keys within a tenant target it).
  UNIQUE KEY uq_inbox_flags_org_id (organization_id, id),
  -- Idempotency guard: the same membership flagging the same bundle twice collides here rather than
  -- creating a second row. Leads with organization_id per 07-DATA-MODEL §9.
  UNIQUE KEY uq_inbox_flags_org_membership_bundle (organization_id, membership_id, bundle_id),
  -- 07-DATA-MODEL §9: the one read that exists — a membership's flags, newest first, id breaking ties
  -- for a total order.
  KEY ix_inbox_flags_org_membership (organization_id, membership_id, created_at, id),
  CONSTRAINT fk_inbox_flags_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_inbox_flags_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
