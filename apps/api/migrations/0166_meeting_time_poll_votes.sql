-- 0166_meeting_time_poll_votes — an invitee's yes/maybe/no on one candidate slot (CAL, x298).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Calendar and meetings",
-- 22-SCREEN-INVENTORY §MTG scheduling, 23-ERD-AND-STATE-MACHINES §2 (parent-owned records),
-- 07-DATA-MODEL §9 (index prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- `0165_meeting_time_polls.sql` landed the candidate slots an organiser proposes. This is the vote
-- against one of those slots: against an option the caller can see (via the meeting), the caller
-- records their **own** answer — one of `yes`, `maybe` or `no`. The vote is keyed on the caller's
-- membership, so a caller can only ever set their own, exactly as `meeting_rsvps` (0112) is.
--
-- ## A vote is a membership, and parent-owned like every sibling
--
-- `meeting_time_poll_votes.membership_id` is `NOT NULL`: a vote is cast by a member of *this*
-- tenant, named by their membership row (the same identity the roster and RSVP use), never a bare
-- `user_id`. The composite foreign key `fk_mtp_votes_membership_tenant` binds `(organization_id,
-- membership_id)` to `memberships (organization_id, id)`, and `fk_mtp_votes_option_tenant` binds
-- `(organization_id, option_id)` to `meeting_time_polls (organization_id, id)` — so a vote row can
-- only ever cite an option *and* a membership of its own tenant: a cross-tenant id does not exist as
-- a pair even when both ids exist individually. The row carries no `project_id`; the relation it is
-- read and written by is the option's meeting's, resolved in the service before the write.
--
-- ## `choice` is an ENUM
--
-- `choice` is a fixed three-value vocabulary, so it is an `ENUM('yes','maybe','no')` — the house
-- pattern for a fixed vocabulary (0001 status/audience, 0112 rsvp response). There is no default: a
-- row exists only once the member has voted, so the choice is always one the member made.
--
-- ## One vote per member per option
--
-- `uq_mtp_votes_option_member (organization_id, option_id, membership_id)` makes a second vote from
-- the same member on the same option an UPDATE of that one row rather than a second row: a member
-- has one current answer per option, so re-voting is idempotent and two answers can never disagree.
--
-- ## Identity is immutable; the choice is not
--
-- `organization_id`, `option_id` and `membership_id` are what a vote row *is*: re-pointing it would
-- move a person's answer onto a different option or member, silently. The `BEFORE UPDATE` trigger
-- pins those three at the engine — ADR-0001 layers 3 and 4 are application-side and a direct SQL
-- session bypasses both. `choice` (and the housekeeping `updated_at`) is what an UPDATE may change —
-- the idempotent re-vote this slice ships — so the trigger leaves them alone.

CREATE TABLE meeting_time_poll_votes (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- NOT NULL. The candidate slot this vote is on. No `project_id` of its own — the relation is the
  -- option's meeting's, so the two can never disagree.
  option_id          CHAR(36)     NOT NULL,
  -- NOT NULL. The voting member, by membership row (not a bare user id) — the same identity the
  -- roster and RSVP use, kept inside this tenant by the composite FK below. A caller can only ever
  -- write the row keyed on their own membership.
  membership_id      CHAR(36)     NOT NULL,
  -- The member's answer. No default: a row exists only once the member has voted.
  choice             ENUM('yes','maybe','no') NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_mtp_votes_org_id (organization_id, id),
  -- One vote per member per option: a re-vote UPDATEs the single row rather than duplicating.
  UNIQUE KEY uq_mtp_votes_option_member (organization_id, option_id, membership_id),
  -- The index an option's votes are counted by: this tenant's votes for this option, in id order.
  -- Leads with `organization_id` per `07-DATA-MODEL` §9.
  KEY ix_mtp_votes_org_option (organization_id, option_id, id),
  -- A vote can only cite an option of its own tenant: the pair (this org, this option) must exist in
  -- `meeting_time_polls`, whose `uq_meeting_time_polls_org_id` is the referenced key.
  CONSTRAINT fk_mtp_votes_option_tenant
    FOREIGN KEY (organization_id, option_id) REFERENCES meeting_time_polls (organization_id, id),
  -- ...and only a membership of its own tenant: the pair (this org, this membership) must exist in
  -- `memberships`, whose `uq_memberships_org_id` is the referenced key.
  CONSTRAINT fk_mtp_votes_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A vote's tenant, option and member are immutable, for the reason `meeting_rsvps`' trigger gives:
-- re-pointing any of the three would move a person's answer onto a different option or member,
-- silently. `choice` and `updated_at` are what an UPDATE may change — the idempotent re-vote this
-- slice ships — so the trigger refuses a change to the identity columns and leaves them alone.
DELIMITER $$

CREATE TRIGGER trg_mtp_votes_immutable
BEFORE UPDATE ON meeting_time_poll_votes FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_time_poll_votes.organization_id is immutable';
  END IF;
  IF NEW.option_id <> OLD.option_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_time_poll_votes.option_id is immutable';
  END IF;
  IF NEW.membership_id <> OLD.membership_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_time_poll_votes.membership_id is immutable';
  END IF;
END$$

DELIMITER ;
