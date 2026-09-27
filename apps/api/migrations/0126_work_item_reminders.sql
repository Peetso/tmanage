-- 0126_work_item_reminders — a personal reminder on a work item (x256, Work module 7).
--
-- Governing sources: 11-USER-STORIES / 38-MODULE-MAP §Work ("due/approval reminders follow
-- policy"), 23-ERD-AND-STATE-MACHINES §2 (tenant-scoped, parent-owned records), 07-DATA-MODEL §9
-- (index prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite
-- tenant keys).
--
-- ## What this migration is for
--
-- A member who can read a work item may set a personal `remind_at` on it — "nudge me about this
-- item at this time" — list their own due reminders, and clear the reminder. This is that reminder
-- at its smallest useful size: one row per (work item, member) that a member sets for themselves
-- and clears for themselves. **No notification is dispatched here** — email/dispatch is a separate,
-- out-of-scope path (Needs-Peter); this migration is storage only.
--
-- ## Parent-, tenant- and member-scoped
--
-- A reminder belongs to one work item of one studio, owned by one membership. `organization_id`
-- scopes it to the tenant the way every sibling table is scoped; the composite foreign key
-- `fk_work_item_reminders_work_item` binds `(organization_id, work_item_id)` to
-- `work_items (organization_id, id)`, so a reminder can only ever name a work item of its own
-- tenant — a cross-tenant `work_item_id` does not exist as a pair even when both ids exist
-- individually. That is the engine half of the trap the service also enforces in code: a
-- cross-tenant parent is a 404, never a write.
--
-- ## One reminder per member per item, upserted
--
-- The unique key `uq_work_item_reminders_member` on `(organization_id, work_item_id, membership_id)`
-- makes "set my reminder" an upsert: a second PUT for the same member on the same item moves the
-- existing row's `remind_at` rather than duplicating it. The runtime credential holds INSERT,
-- UPDATE **and** DELETE (users.sql): update is the upsert's replace path, delete is "clear my
-- reminder". `remind_at` is written from a value the caller supplies (a bound Date), never the
-- admin/session connection's `CURRENT_TIMESTAMP`, so the stored instant does not depend on which
-- pool's clock ran the statement.

CREATE TABLE work_item_reminders (
  id                CHAR(36)    NOT NULL,
  organization_id   CHAR(36)    NOT NULL,
  work_item_id      CHAR(36)    NOT NULL,
  -- The membership of the studio that owns this reminder; `membership_id`, never a raw user id, so
  -- it is scoped to this tenant's directory the way every other actor reference is at rest.
  membership_id     CHAR(36)    NOT NULL,
  -- When to remind. Supplied by the caller as a bound instant, so it is independent of any pool's
  -- clock; the due read compares it against a caller-supplied `before` bound.
  remind_at         DATETIME(3) NOT NULL,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_work_item_reminders_org_id (organization_id, id),
  -- One reminder per member per item: the key that makes "set my reminder" an idempotent upsert.
  -- Leads with `organization_id` per `07-DATA-MODEL` §9.
  UNIQUE KEY uq_work_item_reminders_member (organization_id, work_item_id, membership_id),
  -- The due read: a member's reminders in `remind_at` order, filtered to those at or before a
  -- bound. Leads with `organization_id`, then `membership_id` (own-only), then `remind_at`.
  KEY ix_work_item_reminders_due (organization_id, membership_id, remind_at, id),
  -- A reminder can only ever name a work item of its own tenant; the composite key is what makes a
  -- cross-tenant `work_item_id` a non-existent pair rather than a leak.
  CONSTRAINT fk_work_item_reminders_work_item
    FOREIGN KEY (organization_id, work_item_id) REFERENCES work_items (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
