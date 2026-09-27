-- 0104_work_item_watchers — a work item's watchers / subscribers (x232, Work module 7).
--
-- Governing sources: 38-MODULE-MAP §Work management (the audit's "Work built; no watcher/
-- subscriber model"), 23-ERD-AND-STATE-MACHINES §2 (tenant-scoped, parent-owned records),
-- 07-DATA-MODEL §9 (index prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- A member who can read a work item may subscribe to it so a later notification path can reach
-- the people who care. This is that subscription at its smallest useful size: one row per
-- (work item, member) that a member creates for themselves and removes for themselves — a
-- self-service watch list, nothing more. No notification is dispatched here; that path is the
-- existing notifications module and a later slice's work.
--
-- ## Parent- and tenant-scoped
--
-- A watch belongs to one work item of one studio. `organization_id` scopes it to the tenant the
-- way every sibling table is scoped; the composite foreign key `fk_work_item_watchers_work_item`
-- binds `(organization_id, work_item_id)` to `work_items (organization_id, id)`, so a watch can
-- only ever name a work item of its own tenant — a cross-tenant `work_item_id` does not exist as
-- a pair even when both ids exist individually. That is the engine half of the trap the service
-- also enforces in code: a cross-tenant parent is a 404, never a write.
--
-- ## Idempotent subscribe, self-service unsubscribe
--
-- The unique key `uq_work_item_watchers_member` on `(organization_id, work_item_id, member_id)`
-- is what makes a repeated subscribe idempotent: a second PUT for the same member on the same
-- item finds the row already present rather than duplicating it. Unlike the append-only comments
-- (0053), a watch is removable — the runtime credential holds INSERT **and DELETE** (users.sql),
-- and there is no immutable trigger: unsubscribe deletes the caller's own row.

CREATE TABLE work_item_watchers (
  id                CHAR(36)    NOT NULL,
  organization_id   CHAR(36)    NOT NULL,
  work_item_id      CHAR(36)    NOT NULL,
  -- The membership of the studio that is watching; `membership_id`, never a raw user id, so it is
  -- scoped to this tenant's directory the way every other actor reference is at rest.
  member_id         CHAR(36)    NOT NULL,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_work_item_watchers_org_id (organization_id, id),
  -- One watch per member per item: the key that makes a repeated subscribe idempotent. Leads with
  -- `organization_id` per `07-DATA-MODEL` §9, and also serves the "is this member watching?" read.
  UNIQUE KEY uq_work_item_watchers_member (organization_id, work_item_id, member_id),
  -- A watch can only ever name a work item of its own tenant; the composite key is what makes a
  -- cross-tenant `work_item_id` a non-existent pair rather than a leak.
  CONSTRAINT fk_work_item_watchers_work_item
    FOREIGN KEY (organization_id, work_item_id) REFERENCES work_items (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
