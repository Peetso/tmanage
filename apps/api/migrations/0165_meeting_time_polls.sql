-- 0165_meeting_time_polls — candidate time slots an organiser proposes for a meeting (CAL, x298).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Calendar and meetings" (picking a
-- time everyone can make), 22-SCREEN-INVENTORY §MTG scheduling, 23-ERD-AND-STATE-MACHINES §2
-- (parent-owned records), 07-DATA-MODEL §9 (index prefixes lead with `organization_id`),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- `0029_meetings.sql` (x90) landed the meeting; `0042_meeting_attendees.sql` (x126) the roster and
-- `0112_meeting_rsvps.sql` (x240) a member's own yes/no/maybe to the *scheduled* meeting. This is
-- the step *before* a time is fixed: an organiser proposes several candidate slots, invitees vote on
-- each (`0166_meeting_time_poll_votes.sql`), and the tally picks the time. Each row here is one
-- **candidate slot** — a `(option_start, option_end)` pair under a meeting — not the meeting itself.
--
-- ## Parent-owned, like every sibling
--
-- `meeting_time_polls.meeting_id` is `NOT NULL`: an option belongs to a meeting of *this* tenant.
-- The composite foreign key `fk_meeting_time_polls_meeting_tenant` binds `(organization_id,
-- meeting_id)` to `meetings (organization_id, id)`, so an option can only ever cite a meeting of its
-- own tenant — a cross-tenant id does not exist as a pair even when both ids exist individually. The
-- row carries no `project_id` of its own; the relation it is read and written by is the *meeting's*,
-- resolved in the service before any write, so the two can never disagree.
--
-- ## An option is created and read, never edited
--
-- This slice ships an organiser creating options and everyone reading the tally; there is no
-- edit-an-option surface, so the `tmanage_app` grant is INSERT only (`scripts/db/users.sql`) and
-- there is no immutability trigger — the withheld UPDATE/DELETE privilege is the control, the same
-- treatment `meeting_series` has. `option_end <= option_start` is refused in the service (a 400 with
-- no insert), the house pattern for an ordering rule over two nullable-free columns.

CREATE TABLE meeting_time_polls (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- NOT NULL. The meeting this candidate slot is proposed for; see the note above. No `project_id`
  -- of its own — the relation is the meeting's, so the two can never disagree.
  meeting_id         CHAR(36)     NOT NULL,
  -- The candidate slot's bounds. The service refuses `option_end <= option_start` (400, no insert),
  -- so a stored option is always a forward interval.
  option_start       DATETIME(3)  NOT NULL,
  option_end         DATETIME(3)  NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a child (the votes table)
  -- can reference this row without a cross-tenant path.
  UNIQUE KEY uq_meeting_time_polls_org_id (organization_id, id),
  -- The index a meeting's options are listed by: this tenant's options for this meeting, in id
  -- (≈ creation) order. Leads with `organization_id` per `07-DATA-MODEL` §9.
  KEY ix_meeting_time_polls_org_meeting (organization_id, meeting_id, id),
  -- An option can only cite a meeting of its own tenant: the pair (this org, this meeting) must
  -- exist in `meetings`, whose `uq_meetings_org_id` is the referenced key.
  CONSTRAINT fk_meeting_time_polls_meeting_tenant
    FOREIGN KEY (organization_id, meeting_id) REFERENCES meetings (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
