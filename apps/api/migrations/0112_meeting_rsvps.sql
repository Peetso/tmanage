-- 0112_meeting_rsvps — a meeting attendee's own response: accept / decline / tentative (CAL, x240).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Calendar and meetings" (whether an
-- invited member is coming), 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §Calendar, 23-ERD-AND-STATE-
-- MACHINES §2 (parent-owned records), 07-DATA-MODEL §9 (index prefixes lead with `organization_id`),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- `0029_meetings.sql` (x90) landed the meeting and `0042_meeting_attendees.sql` (x126) the invite
-- roster an organiser manages. Neither is a member speaking for *themselves*: this is that table —
-- against a meeting the caller can see, the caller records their **own** response, one of
-- `accepted`, `declined` or `tentative`. It is distinct from the attendee roster: the roster is an
-- organiser inviting members (`meeting.write` over anyone); this is a member answering for the one
-- person the request can name — themselves. The response is keyed on the caller's membership, so a
-- caller can only ever set their own.
--
-- ## A response is a membership, and parent-owned like every sibling
--
-- `meeting_rsvps.member_id` is `NOT NULL`: a response is given by a member of *this* tenant, named
-- by their membership row (the same identity the roster and project membership use), never a bare
-- `user_id`. The composite foreign key `fk_meeting_rsvps_member_tenant` binds
-- `(organization_id, member_id)` to `memberships (organization_id, id)`, and
-- `fk_meeting_rsvps_meeting_tenant` binds `(organization_id, meeting_id)` to
-- `meetings (organization_id, id)` — so a response row can only ever cite a meeting *and* a
-- membership of its own tenant: a cross-tenant id does not exist as a pair even when both ids exist
-- individually. The relation a response is read and written by is the *meeting's* project relation,
-- resolved in the service before the write; this table carries no `project_id` of its own, so it
-- can never disagree with its meeting's.
--
-- ## `response` is an ENUM
--
-- `response` is a fixed three-value vocabulary, so it is an
-- `ENUM('accepted','declined','tentative')` — the house pattern for a fixed vocabulary (0001
-- status/audience, 0042 rsvp). There is no default: a row exists only once the member has answered,
-- so the response is always one the member chose, never an implicit placeholder.
--
-- ## One response per member per meeting
--
-- `uq_meeting_rsvps_meeting_member (organization_id, meeting_id, member_id)` makes a second response
-- from the same member to the same meeting an UPDATE of that one row rather than a second row: a
-- member has one current answer, so re-answering is idempotent and two responses for one person can
-- never disagree.
--
-- ## Identity is immutable; the response is not
--
-- `organization_id`, `meeting_id` and `member_id` are what a response row *is*: re-pointing it would
-- move a person's answer onto a different meeting or a different member, silently. The
-- `BEFORE UPDATE` trigger pins those three at the engine — ADR-0001 layers 3 and 4 are
-- application-side and a direct SQL session bypasses both. `response` (and the housekeeping
-- `updated_at`) is what an UPDATE may change — that is the idempotent re-answer this slice ships —
-- so the trigger leaves them alone.

CREATE TABLE meeting_rsvps (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- NOT NULL. A response belongs to a meeting; see the note above. No `project_id` of its own —
  -- the relation is the meeting's, so the two can never disagree.
  meeting_id         CHAR(36)     NOT NULL,
  -- NOT NULL. The responding member, by membership row (not a bare user id) — the same identity the
  -- roster and project membership use, kept inside this tenant by the composite FK below. A caller
  -- can only ever write the row keyed on their own membership.
  member_id          CHAR(36)     NOT NULL,
  -- The member's answer. No default: a row exists only once the member has answered.
  response           ENUM('accepted','declined','tentative') NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_meeting_rsvps_org_id (organization_id, id),
  -- One response per member per meeting: a re-answer UPDATEs the single row rather than duplicating,
  -- so two answers for one person can never coexist.
  UNIQUE KEY uq_meeting_rsvps_meeting_member (organization_id, meeting_id, member_id),
  -- The index a meeting's responses are counted and listed by: this tenant's responses for this
  -- meeting, in id (≈ creation) order. Leads with `organization_id` per `07-DATA-MODEL` §9.
  KEY ix_meeting_rsvps_org_meeting (organization_id, meeting_id, id),
  -- A response can only cite a meeting of its own tenant: the pair (this org, this meeting) must
  -- exist in `meetings`, whose `uq_meetings_org_id` is the referenced key.
  CONSTRAINT fk_meeting_rsvps_meeting_tenant
    FOREIGN KEY (organization_id, meeting_id) REFERENCES meetings (organization_id, id),
  -- ...and only a membership of its own tenant: the pair (this org, this membership) must exist in
  -- `memberships`, whose `uq_memberships_org_id` is the referenced key.
  CONSTRAINT fk_meeting_rsvps_member_tenant
    FOREIGN KEY (organization_id, member_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A response's tenant, meeting and member are immutable, for the reason `meeting_attendees`' trigger
-- gives: re-pointing any of the three would move a person's answer onto a different meeting or
-- member, silently. `response` and `updated_at` are what an UPDATE may change — the idempotent
-- re-answer this slice ships — so the trigger refuses a change to the identity columns and leaves
-- them alone.
DELIMITER $$

CREATE TRIGGER trg_meeting_rsvps_immutable
BEFORE UPDATE ON meeting_rsvps FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_rsvps.organization_id is immutable';
  END IF;
  IF NEW.meeting_id <> OLD.meeting_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_rsvps.meeting_id is immutable';
  END IF;
  IF NEW.member_id <> OLD.member_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_rsvps.member_id is immutable';
  END IF;
END$$

DELIMITER ;
