-- 0033_meeting_notes — a meeting's captured notes and decisions (CAL-01 / MTG-01 second slice,
-- x105).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Calendar and meetings" ("a
-- meeting closes with linked decisions and actions, not loose notes"), 41-WHOLE-APP-SCREEN-AND-
-- STATE-MATRIX §Calendar (meeting notes & decisions), 23-ERD-AND-STATE-MACHINES §2
-- (`… ||--o{ …` parent-owned records), 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- `0029_meetings.sql` (x90) landed a meeting as a durable record and deferred its notes and
-- decisions: doc 38 says a meeting "closes with linked decisions and actions", and the meetings
-- table deliberately carried no linkage before a table existed to link to. This is that table:
-- against an existing meeting, a **note or a decision** — a `kind`, a `body`, an author and a
-- time. It is the capture-and-read counterpart, and deliberately *not* the whole vision. There
-- is no decision approval/lock lifecycle, no linked actions, and no dedicated screen: those are
-- the next slice (x105-b), each with its own state and columns. Adding a `state`, an
-- `approved_by` or an `action_id` here — before the code that fills them exists — would be the
-- shape no reviewer agreed to that `0007_conversations.sql` refused with its absent `kind`
-- column. So this table carries only what a note *is* at rest.
--
-- ## Notes and decisions share one table
--
-- A decision is a note with `kind='decision'`: it records the choice a meeting reached, with the
-- same author/body/time shape a note has. A separate `decisions` table is deferred until review
-- shows a distinct lifecycle (approval/lock) that a note does not have — at which point a
-- decision grows its own columns and a state machine, and a migration adds them. Until then, one
-- `kind` column is the honest shape (the same judgement `conversations`/`messages` make for a
-- message's variants), and it keeps the read a single ordered list of a meeting's record.
--
-- ## Parent-owned, and tenant-scoped like every sibling
--
-- `meeting_notes.meeting_id` is `NOT NULL`: a note belongs to a meeting, the way a meeting
-- belongs to a project. The composite foreign key `fk_meeting_notes_meeting_tenant` binds
-- `(organization_id, meeting_id)` to `meetings (organization_id, id)` — its `uq_meetings_org_id`
-- key — so a note can only ever cite a meeting of its own tenant: a cross-tenant meeting id does
-- not exist as a pair even when both ids exist individually. The relation a note is read and
-- written by is the *meeting's* project relation, resolved in the service before the write; this
-- table carries no `project_id` of its own, so it can never disagree with its meeting's.
--
-- ## `kind` is an ENUM
--
-- `kind` is a fixed two-value vocabulary, so it is an `ENUM('note','decision')` — the house
-- pattern for a fixed vocabulary (0001 status/audience), not the in-place CHECK 0026 used to
-- constrain an already-shipped VARCHAR. `body` is `TEXT` and `NOT NULL`: it is prose a person
-- types, the choice `conversations.body` and `documents.body` made.
--
-- ## A note is immutable, append-only
--
-- A captured note or decision is a record of what was said or chosen; overwriting it would
-- rewrite that record silently. This slice has no edit or delete endpoint, and the row is
-- immutable at the engine — the `BEFORE UPDATE` trigger refuses every change, the way
-- `deliverable_versions` (0027) holds its append-only record. ADR-0001 layers 3 and 4 are
-- application-side and a direct SQL session bypasses both, so the guarantee lives at the engine.

CREATE TABLE meeting_notes (
  id                 CHAR(36)               NOT NULL,
  organization_id    CHAR(36)               NOT NULL,
  -- NOT NULL. A note belongs to a meeting; see the note above. No `project_id` of its own — the
  -- relation is the meeting's, so the two can never disagree.
  meeting_id         CHAR(36)               NOT NULL,
  -- A note, or a decision the meeting reached. One table, per the note above.
  kind               ENUM('note','decision') NOT NULL,
  -- The note or decision text. Prose a person types, so TEXT and NOT NULL — the choice
  -- `conversations.body` (0007) and `documents.body` (0030) made.
  body               TEXT                   NOT NULL,
  -- The person who captured it — the service passes `context.userId`.
  author_user_id     CHAR(36)               NOT NULL,
  created_at         DATETIME(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_meeting_notes_org_id (organization_id, id),
  -- The index a meeting's notes are listed by: this tenant's notes for this meeting, in id
  -- (≈ creation) order — the deterministic list this slice reads. Leads with `organization_id`
  -- per `07-DATA-MODEL` §9.
  KEY ix_meeting_notes_org_meeting (organization_id, meeting_id, id),
  -- A note can only cite a meeting of its own tenant: the pair (this org, this meeting) must
  -- exist in `meetings`, whose `uq_meetings_org_id` is the referenced key.
  CONSTRAINT fk_meeting_notes_meeting_tenant
    FOREIGN KEY (organization_id, meeting_id) REFERENCES meetings (organization_id, id),
  CONSTRAINT fk_meeting_notes_author
    FOREIGN KEY (author_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A captured note or decision is immutable: it is the record of what was said or chosen, and this
-- slice has no edit surface. The trigger refuses every UPDATE at the engine, the reason
-- `deliverable_versions`' trigger (0027) exists — a direct SQL session bypasses the application
-- layers. When an edit or a decision-lifecycle surface lands (x105-b), it arrives with the code
-- that writes it and this trigger is relaxed to the columns that may then change.
DELIMITER $$

CREATE TRIGGER trg_meeting_notes_immutable
BEFORE UPDATE ON meeting_notes FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'meeting_notes rows are immutable';
END$$

DELIMITER ;
