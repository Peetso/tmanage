-- 0136_meeting_action_items — action items captured on a meeting: what someone will do, who owns
-- it, and when it is due (CAL / MTG-03, x266).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Calendar and meetings" ("a meeting
-- closes with linked decisions and actions"), MTG-03 "Meeting summary" (decisions, actions),
-- 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §Calendar, 23-ERD-AND-STATE-MACHINES §2 (parent-owned
-- records), 07-DATA-MODEL §9 (index prefixes lead with `organization_id`),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- `0029_meetings.sql` (x90) landed the meeting and `0033_meeting_notes.sql` captured its notes and
-- decisions — but that slice deferred the linked *actions* explicitly ("no linked actions … the
-- next slice"). This is that table: against a meeting the caller can see, an action item records a
-- `title` (what will be done), an optional `owner_membership_id` (who owns it) and an optional
-- `due_on` (when), and moves between `open` and `done`. The action item is read and written behind
-- the meeting's own capabilities (`meeting.read` / `meeting.write`); its relation is the meeting's
-- project relation, resolved in the service before any write, so this table carries no `project_id`
-- of its own and the two can never disagree.
--
-- ## An action item is parent-owned, like every meeting child
--
-- `meeting_action_items.meeting_id` is `NOT NULL`: an action item belongs to a meeting of *this*
-- tenant. The composite foreign key `fk_meeting_action_items_meeting_tenant` binds
-- `(organization_id, meeting_id)` to `meetings (organization_id, id)`, so an action item row can
-- only ever cite a meeting of its own tenant — a cross-tenant `meeting_id` does not exist as a pair
-- even when both ids exist individually.
--
-- ## The owner is a membership of the same tenant, and optional
--
-- `owner_membership_id` is `NULL`-able: an action item may be captured before it is assigned. When
-- present it is a membership row — the same identity the roster and project membership use, never a
-- bare `user_id` — and `fk_meeting_action_items_owner_tenant` binds
-- `(organization_id, owner_membership_id)` to `memberships (organization_id, id)`, so an assigned
-- owner is always a member of this tenant. With the owner NULL the composite FK is not checked
-- (InnoDB MATCH SIMPLE), which is exactly the "unassigned" case. The service resolves a supplied
-- owner tenant-scoped before the write besides, so an unknown owner is a clean not-found rather than
-- a driver foreign-key error.
--
-- ## `status` is an ENUM with a default
--
-- `status` is a fixed two-value vocabulary, so it is an `ENUM('open','done')` — the house pattern
-- for a fixed vocabulary (0001 status/audience, 0042 rsvp). It defaults to `open`: a freshly
-- captured action item is outstanding until someone marks it done.
--
-- ## Identity is immutable; the rest is not
--
-- `organization_id` and `meeting_id` are what an action item row *is*: re-pointing either would move
-- an action onto a different tenant or meeting, silently. The `BEFORE UPDATE` trigger pins those two
-- at the engine — ADR-0001 layers 3 and 4 are application-side and a direct SQL session bypasses
-- both. `title`, `owner_membership_id`, `due_on`, `status` and the housekeeping `updated_at` are what
-- an UPDATE may change — the edit and the open/done toggle this slice ships — so the trigger leaves
-- them alone.

CREATE TABLE meeting_action_items (
  id                   CHAR(36)     NOT NULL,
  organization_id      CHAR(36)     NOT NULL,
  -- NOT NULL. An action item belongs to a meeting; see the note above. No `project_id` of its own —
  -- the relation is the meeting's, so the two can never disagree.
  meeting_id           CHAR(36)     NOT NULL,
  -- What will be done. Non-empty is enforced in the service (empty title -> 400); the column is
  -- simply NOT NULL.
  title                VARCHAR(500) NOT NULL,
  -- The owner, by membership row (not a bare user id), or NULL for an unassigned action. Kept inside
  -- this tenant by the composite FK below when present.
  owner_membership_id  CHAR(36)     NULL,
  -- When the action is due, a date-only value (no time zone), or NULL for no due date.
  due_on               DATE         NULL,
  -- Outstanding or completed. Defaults to `open`: a freshly captured action item is outstanding.
  status               ENUM('open','done') NOT NULL DEFAULT 'open',
  created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_meeting_action_items_org_id (organization_id, id),
  -- The index a meeting's action items are listed by: this tenant's items for this meeting, in id
  -- (≈ creation) order. Leads with `organization_id` per `07-DATA-MODEL` §9.
  KEY ix_meeting_action_items_org_meeting (organization_id, meeting_id, id),
  -- An action item can only cite a meeting of its own tenant: the pair (this org, this meeting) must
  -- exist in `meetings`, whose `uq_meetings_org_id` is the referenced key.
  CONSTRAINT fk_meeting_action_items_meeting_tenant
    FOREIGN KEY (organization_id, meeting_id) REFERENCES meetings (organization_id, id),
  -- ...and an assigned owner can only be a membership of its own tenant: when present, the pair
  -- (this org, this owner) must exist in `memberships`, whose `uq_memberships_org_id` is referenced.
  -- With `owner_membership_id` NULL the constraint is not checked (the unassigned case).
  CONSTRAINT fk_meeting_action_items_owner_tenant
    FOREIGN KEY (organization_id, owner_membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An action item's tenant and meeting are immutable, for the reason `meeting_attendees`' trigger
-- gives: re-pointing either would move an action onto a different tenant or meeting, silently.
-- `title`, `owner_membership_id`, `due_on`, `status` and `updated_at` are what an UPDATE may change —
-- the edit and the open/done toggle this slice ships — so the trigger refuses a change to the two
-- identity columns and leaves the rest alone.
DELIMITER $$

CREATE TRIGGER trg_meeting_action_items_immutable
BEFORE UPDATE ON meeting_action_items FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_action_items.organization_id is immutable';
  END IF;
  IF NEW.meeting_id <> OLD.meeting_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_action_items.meeting_id is immutable';
  END IF;
END$$

DELIMITER ;
