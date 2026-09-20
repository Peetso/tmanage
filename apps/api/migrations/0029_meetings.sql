-- 0029_meetings — the first durable calendar record (CAL-01 / MTG-01, x90 slice 1).
--
-- Governing sources: 38-PRODUCT-SURFACE §"Calendar and meetings" ("a meeting closes with
-- linked decisions and actions, not loose notes", marked Post-MVP design complete),
-- 41-INFORMATION-ARCHITECTURE §7 (CAL-01 / MTG-01..04), 23-ERD-AND-STATE-MACHINES §2
-- (`PROJECT ||--o{ …` project-owned records), 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- The `/calendar` route is a stub and nothing in the schema can hold a meeting. This is the
-- smallest useful unit that changes that: a **project meeting** — a title, a start time and an
-- agenda note — as a durable, tenant-scoped record. It is deliberately *not* the whole of the
-- doc-38 vision. There is no live-call/companion surface, and no linkage to decisions or
-- actions: doc 38 says a meeting "closes with linked decisions and actions", and those tables
-- and their state machine are the next slice. Adding a `decisions`/`actions` link column here,
-- before either table exists, would be a foreign key with nothing to reference and a shape no
-- reviewer agreed to — the same mistake `0007_conversations.sql` refused with its absent `kind`
-- column. So this table carries only what a meeting *is* at rest.
--
-- ## Project channels only, and tenant-scoped like every sibling
--
-- `meetings.project_id` is `NOT NULL`: a meeting belongs to a project, the way a conversation
-- does. `meeting.read` is relation-gated in the same way `work.read` is (project membership),
-- so a meeting with no project would have no relation for the evaluator to check. The composite
-- foreign key `fk_meetings_project_tenant` binds `(organization_id, project_id)` to `projects`,
-- so a meeting can only ever name a project of its own tenant — a cross-tenant project id does
-- not exist as a pair even when both ids exist individually.
--
-- ## `starts_at` is an instant, not a calendar date
--
-- Unlike `projects.forecast_at` (a calendar date, `DATE` since 0012), a meeting's start is a
-- point in time — 14:00 on a given day, in a given zone — so it is `DATETIME(3)` and the
-- application stores a UTC instant. The day-early defect 0012 removed does not apply: a time is
-- meant to move with the reader's zone, a date is not.
--
-- ## Identity is immutable
--
-- `organization_id` and `project_id` are what a meeting is: re-pointing a meeting at another
-- project would move it, silently, into a room a different set of people can read. The
-- `BEFORE UPDATE` trigger holds that at the engine, the reason every other trigger in this
-- schema exists — ADR-0001 layers 3 and 4 are application-side and a direct SQL session
-- bypasses both. `title`, `starts_at` and `agenda_note` are editable; identity is not.

CREATE TABLE meetings (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- NOT NULL. A meeting belongs to a project; see the note above.
  project_id         CHAR(36)     NOT NULL,
  -- `client_requests.title` is VARCHAR(300); a meeting title is the same kind of short handle.
  title              VARCHAR(300) NOT NULL,
  -- A point in time, stored as a UTC instant. See the note above about the DATE/DATETIME split.
  starts_at          DATETIME(3)  NOT NULL,
  -- The agenda note. Optional, and TEXT rather than VARCHAR because it is prose a person types
  -- rather than a form field with a column-width rule. Rich text and attachments are later.
  agenda_note        TEXT         NULL,
  created_by_user_id CHAR(36)     NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child
  -- (a meeting's decisions/actions) can reference this row without a cross-tenant path.
  UNIQUE KEY uq_meetings_org_id (organization_id, id),
  -- The index a project's meetings are listed by: this tenant's meetings for this project,
  -- soonest first. Leads with `organization_id` per `07-DATA-MODEL` §9.
  KEY ix_meetings_org_project (organization_id, project_id, starts_at),
  CONSTRAINT fk_meetings_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_meetings_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A meeting's tenant and project are immutable, for the reason `conversations`' trigger gives:
-- re-pointing a meeting at another project would move it into a room a different set of people
-- can read, silently. Editing is a change to `title`, `starts_at` and `agenda_note` and to
-- nothing else.
DELIMITER $$

CREATE TRIGGER trg_meetings_immutable
BEFORE UPDATE ON meetings FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meetings.organization_id is immutable';
  END IF;
  IF NEW.project_id <> OLD.project_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meetings.project_id is immutable';
  END IF;
  IF NEW.created_by_user_id <> OLD.created_by_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meetings.created_by_user_id is immutable';
  END IF;
END$$

DELIMITER ;
