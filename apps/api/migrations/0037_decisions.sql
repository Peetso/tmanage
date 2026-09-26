-- 0037_decisions — the cross-meeting decision register (DEC-01, x113 slice 1).
--
-- Migration number: the highest migration on this branch's base (pass-16 master 10aab0c) is
-- 0032_import_rows. Numbers 0033–0036 are reserved by slices on sibling branches not yet
-- integrated (x105 meeting_notes = 0033 among them), so this file is named 0037 to sit above
-- every reservation. The migrator applies files in ascending numeric order and a gap is not an
-- error (it rejects only a NEW file numbered *below* an applied one), so 0037 on top of 0032 is
-- correct on this base. If integration renumbers the reservations, the integrator renumbers this
-- file with them; nothing here depends on the literal 0037 beyond the filename.
--
-- Governing sources: 38-MODULE-MAP §Meetings/Decisions ("a meeting closes with linked decisions
-- and actions, not loose notes"), 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §Decisions DEC-01 (the
-- decision register), 23-ERD-AND-STATE-MACHINES §2 (`PROJECT ||--o{ …` project-owned records),
-- 07-DATA-MODEL §9 (index prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- `schema.ts` (the meetings comment, 0029) records that a meeting "closes with linked decisions
-- and actions" as "the next slice". x105 (0033) adds `meeting_notes`: a note/decision *kind* the
-- caption of one meeting. This is the other half — a first-class, cross-meeting **register**: the
-- decisions a project has taken, each with a status, an author, the instant it was decided, and an
-- optional link to the meeting it was taken in. It is deliberately *not* the whole DEC vision.
-- There is no approval/lock lifecycle, no supersede-chain edges, and no linked actions: those are
-- DEC-01's later slices (NEXT-SCOPES-9). This table carries only what a decision *is* at rest.
--
-- ## Project-owned, and tenant-scoped like every sibling
--
-- `decisions.project_id` is `NOT NULL`: a decision belongs to a project, the way a meeting and a
-- document do. Authorization is relation-gated on the project (see `DecisionsService`), so a
-- decision with no project would have no relation to check. The composite foreign key
-- `fk_decisions_project_tenant` binds `(organization_id, project_id)` to `projects`, so a decision
-- can only ever name a project of its own tenant — a cross-tenant project id does not exist as a
-- pair even when both ids exist individually.
--
-- ## The meeting link is optional, and cross-tenant-proof when present
--
-- `meeting_id` is `NULL`able: a decision may be taken outside any meeting (a register entry that
-- records a call, an email thread, a corridor call). When it *is* set, `fk_decisions_meeting_tenant`
-- binds `(organization_id, meeting_id)` to `meetings`. Because `organization_id` is always present
-- and `meeting_id` is the only nullable half, InnoDB's MATCH SIMPLE semantics skip the check only
-- when `meeting_id` is NULL — a non-null `meeting_id` is always checked against the same tenant, so
-- a decision can never cite another tenant's meeting. That is the "guarded nullable (org, meeting)"
-- DEC-01 asks for.
--
-- ## A decided instant, not a calendar date
--
-- `decided_at` is the point in time the decision was taken, so it is `DATETIME(3)` and stores a UTC
-- instant, the choice `meetings.starts_at` made — unlike `projects.forecast_at`, a calendar `DATE`.
--
-- ## Append-only: a decision is a record of what was chosen
--
-- This slice has no edit surface, and a decision on the register is the durable record of a choice
-- the project made. The `BEFORE UPDATE` trigger refuses every UPDATE at the engine — the reason
-- `meeting_notes` (0033) and `client_projections` (0031) carry the same trigger: ADR-0001 layers 3
-- and 4 are application-side and a direct SQL session bypasses both. When the decision lifecycle
-- lands (status transitions, supersede edges — NEXT-SCOPES-9), it arrives with the code that writes
-- it and this trigger is relaxed to the columns that may then change, exactly as `meeting_notes`'
-- comment promises for its own.

CREATE TABLE decisions (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- NOT NULL. A decision belongs to a project; see the note above.
  project_id         CHAR(36)     NOT NULL,
  -- Optional. The meeting the decision was taken in, when there was one. See the note above.
  meeting_id         CHAR(36)     NULL,
  -- `meetings.title` / `documents.title` are VARCHAR(300); a decision's headline is the same kind
  -- of short handle.
  title              VARCHAR(300) NOT NULL,
  -- The decision itself, in words. Prose a person types, so TEXT and NOT NULL — the choice
  -- `documents.body` (0030) and `meeting_notes.body` (0033) made.
  statement          TEXT         NOT NULL,
  -- Where the decision sits in its short lifecycle. Set at creation this slice; the transitions
  -- between these values are DEC-01's later lifecycle slice (NEXT-SCOPES-9).
  status             ENUM('proposed','accepted','superseded') NOT NULL DEFAULT 'proposed',
  -- The person who took the decision — the service passes `context.userId`.
  decided_by         CHAR(36)     NOT NULL,
  -- A point in time, stored as a UTC instant. See the DATE/DATETIME note above.
  decided_at         DATETIME(3)  NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child (a
  -- decision's linked actions or supersede edge) can reference this row without a cross-tenant path.
  UNIQUE KEY uq_decisions_org_id (organization_id, id),
  -- The index a project's register is listed by: this tenant's decisions for this project, most
  -- recently decided first (the list reads `decided_at DESC`). Leads with `organization_id` per
  -- `07-DATA-MODEL` §9.
  KEY ix_decisions_org_project (organization_id, project_id, decided_at),
  CONSTRAINT fk_decisions_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  -- Nullable composite: enforced only when `meeting_id` is set (MATCH SIMPLE), and then against
  -- the same tenant. See the note above.
  CONSTRAINT fk_decisions_meeting_tenant
    FOREIGN KEY (organization_id, meeting_id) REFERENCES meetings (organization_id, id),
  CONSTRAINT fk_decisions_decided_by
    FOREIGN KEY (decided_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A recorded decision is immutable: it is the register's record of what the project chose, and this
-- slice has no edit surface. The trigger refuses every UPDATE at the engine, the reason
-- `meeting_notes` (0033) and `client_projections` (0031) carry it — a direct SQL session bypasses
-- the application layers. When the decision lifecycle lands (NEXT-SCOPES-9) it arrives with the code
-- that writes it and this trigger is relaxed to the columns that may then change.
DELIMITER $$

CREATE TRIGGER trg_decisions_immutable
BEFORE UPDATE ON decisions FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'decisions rows are immutable';
END$$

DELIMITER ;
