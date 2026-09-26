-- 0042_meeting_attendees — a meeting's attendees and their RSVP (CAL-01 / MTG-01, x126).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Calendar and meetings"
-- (attendees/RSVP were the deferred half of the module, NS-11), 41-WHOLE-APP-SCREEN-AND-STATE-
-- MATRIX §Calendar (who is invited and whether they are coming), 23-ERD-AND-STATE-MACHINES §2
-- (parent-owned records), 07-DATA-MODEL §9 (index prefixes lead with `organization_id`),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- `0029_meetings.sql` (x90) landed the meeting itself and `0033_meeting_notes.sql` (x105) its
-- notes and decisions; neither could hold who is invited or whether they are coming. This is that
-- table: against an existing meeting, a **member** (by membership, not raw user) and their
-- **RSVP** — `invited`, `accepted` or `declined`. It is the attendees-and-RSVP half the calendar
-- audit marked Partial and NS-11 deferred; email invites and an ICS attachment stay out (NS-13).
--
-- ## Attendees are memberships, and parent-owned like every sibling
--
-- `meeting_attendees.membership_id` is `NOT NULL`: an attendee is a member of *this* tenant, named
-- by their membership row, not a bare `user_id` — the same identity the roster and project
-- membership use, so an attendee carries a member's role/scope context and can never be a user
-- from outside the organization. The composite foreign key `fk_meeting_attendees_membership_tenant`
-- binds `(organization_id, membership_id)` to `memberships (organization_id, id)`, and
-- `fk_meeting_attendees_meeting_tenant` binds `(organization_id, meeting_id)` to
-- `meetings (organization_id, id)` — so an attendee row can only ever cite a meeting *and* a
-- membership of its own tenant: a cross-tenant id does not exist as a pair even when both ids
-- exist individually. The relation an attendee is read and written by is the *meeting's* project
-- relation, resolved in the service before the write; this table carries no `project_id` of its
-- own, so it can never disagree with its meeting's.
--
-- ## `rsvp` is an ENUM
--
-- `rsvp` is a fixed three-value vocabulary, so it is an `ENUM('invited','accepted','declined')` —
-- the house pattern for a fixed vocabulary (0001 status/audience, 0033 note kind), defaulting to
-- `invited` because that is what an attendee *is* the moment they are added, before they answer.
--
-- ## One row per member per meeting
--
-- `uq_meeting_attendees_meeting_member (organization_id, meeting_id, membership_id)` makes a second
-- invite of the same member to the same meeting a duplicate-key collision rather than a second row:
-- an attendee is invited once and then answers, so the RSVP is an UPDATE of that one row, never a
-- new row that would let two RSVPs for one person disagree.
--
-- ## Identity is immutable; the RSVP is not
--
-- `organization_id`, `meeting_id` and `membership_id` are what an attendee row *is*: re-pointing it
-- would move a person's RSVP onto a different meeting or a different member, silently. The
-- `BEFORE UPDATE` trigger pins those three at the engine, the reason every other trigger in this
-- schema exists — ADR-0001 layers 3 and 4 are application-side and a direct SQL session bypasses
-- both. `rsvp` is the one column an UPDATE may change (that is the PATCH this slice ships), so the
-- trigger leaves it alone.

CREATE TABLE meeting_attendees (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- NOT NULL. An attendee belongs to a meeting; see the note above. No `project_id` of its own —
  -- the relation is the meeting's, so the two can never disagree.
  meeting_id         CHAR(36)     NOT NULL,
  -- NOT NULL. The invited member, by membership row (not a bare user id) — the same identity the
  -- roster and project membership use, kept inside this tenant by the composite FK below.
  membership_id      CHAR(36)     NOT NULL,
  -- The attendee's answer. Defaults to `invited`: what an attendee is the moment they are added.
  rsvp               ENUM('invited','accepted','declined') NOT NULL DEFAULT 'invited',
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_meeting_attendees_org_id (organization_id, id),
  -- One row per member per meeting: a re-invite collides rather than duplicating, so the RSVP is
  -- an UPDATE of a single row and two answers for one person can never coexist.
  UNIQUE KEY uq_meeting_attendees_meeting_member (organization_id, meeting_id, membership_id),
  -- The index a meeting's attendees are listed by: this tenant's attendees for this meeting, in id
  -- (≈ creation) order — the deterministic list this slice reads. Leads with `organization_id`
  -- per `07-DATA-MODEL` §9.
  KEY ix_meeting_attendees_org_meeting (organization_id, meeting_id, id),
  -- An attendee can only cite a meeting of its own tenant: the pair (this org, this meeting) must
  -- exist in `meetings`, whose `uq_meetings_org_id` is the referenced key.
  CONSTRAINT fk_meeting_attendees_meeting_tenant
    FOREIGN KEY (organization_id, meeting_id) REFERENCES meetings (organization_id, id),
  -- ...and only a membership of its own tenant: the pair (this org, this membership) must exist in
  -- `memberships`, whose `uq_memberships_org_id` is the referenced key.
  CONSTRAINT fk_meeting_attendees_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An attendee's tenant, meeting and member are immutable, for the reason `meetings`' trigger gives:
-- re-pointing any of the three would move a person's RSVP onto a different meeting or member,
-- silently. `rsvp` is the one column an UPDATE may change — the PATCH this slice ships — so the
-- trigger refuses a change to the identity columns and leaves `rsvp` alone.
DELIMITER $$

CREATE TRIGGER trg_meeting_attendees_immutable
BEFORE UPDATE ON meeting_attendees FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_attendees.organization_id is immutable';
  END IF;
  IF NEW.meeting_id <> OLD.meeting_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_attendees.meeting_id is immutable';
  END IF;
  IF NEW.membership_id <> OLD.membership_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_attendees.membership_id is immutable';
  END IF;
END$$

DELIMITER ;
