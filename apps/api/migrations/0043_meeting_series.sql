-- 0043_meeting_series — recurring meeting series (CAL recurrence, x129).
--
-- Governing sources: 38-MODULE-MAP §Calendar (recurrence, audit "Calendar Partial; recurrence
-- deferred"); 07-DATA-MODEL §9 (every composite index begins with organization_id); the house
-- tenant-table shape (0028 import_jobs is the nearest org-scoped precedent, 0035 saved_context the
-- nearest INSERT-only-and-read one).
--
-- ## Migration numbering
--
-- Numbered 0043 as reserved by NEXT-SCOPES-12 (pass 20; calendar recurrence after the pass-19
-- calendar slice x122). The highest migration on this slice's base (x122) is 0035; 0036-0042 land
-- on master from parallel branches. The number is a set member, not a position (migrator.db.test
-- treats gaps as legitimate), so the integrator renumbers this file only if a collision appears
-- after the parallel merges.
--
-- ## What this table is, and what it deliberately is not
--
-- One row per **recurring meeting series** — a rule, not an event. A series carries a title, a
-- recurrence frequency (daily/weekly/monthly), an every-N interval and an optional end date
-- (`until`). It is org-scoped, NOT project-scoped: unlike a `meetings` (0029) row it names no
-- project, so it is read/written behind `meeting.read`/`meeting.write` at the tenant level with no
-- project relation to check (`ResourceContext.projectId` is null for it).
--
-- The occurrences a series implies are **expanded on read**, in a bounded window, and never
-- materialised: there is no per-occurrence row here, so there is nothing to override, cancel or
-- attach to yet. Per-occurrence overrides and materialising rows are deferred to NEXT-SCOPES-13
-- (recommended: read-side expand only until an override spec is chosen). The expansion anchor is
-- the series' own creation date (`created_at`), so a series with no explicit start still expands
-- deterministically; an explicit anchor/time-of-day is part of the deferred override work.
--
-- ## freq is an ENUM; interval is a positive integer
--
-- `freq` is a closed three-value vocabulary the application owns, so an ENUM rather than a free
-- string: a typo is a write error and the three kinds are the only ones storable. `recurrence_interval`
-- is INT UNSIGNED with a CHECK (>= 1): "every 0 weeks" is not a recurrence, and a non-positive
-- interval would make expansion non-terminating.
--
-- ## Tenant scope and lifecycle
--
-- `(organization_id, id)` is unique so a future child (a materialised occurrence, an override) can
-- reference a series with a composite foreign key that binds to the same tenant, never a
-- cross-tenant path — the arrangement every scoped table here carries. This slice creates and reads
-- a series and never edits or removes one: there is no UPDATE or DELETE endpoint, the runtime
-- credential is granted INSERT only (scripts/db/users.sql), and so — like 0035 saved_context — the
-- withheld privilege is the control and no immutability trigger is needed.

CREATE TABLE meeting_series (
  id                   CHAR(36)                             NOT NULL,
  organization_id      CHAR(36)                             NOT NULL,
  -- `meetings.title` is VARCHAR(300); a series title is the same kind of short handle.
  title                VARCHAR(300)                         NOT NULL,
  -- The recurrence frequency. ENUM so the three kinds are the only ones storable and a typo is a
  -- write error, the choice 0033 meeting_notes.kind makes.
  freq                 ENUM('daily','weekly','monthly')     NOT NULL,
  -- The every-N interval: 1 = every period, 2 = every other, and so on. Named `recurrence_interval`
  -- rather than `interval` because INTERVAL is a MySQL reserved word; the view field is `interval`.
  recurrence_interval  INT UNSIGNED                         NOT NULL,
  -- The optional last calendar date the series may recur on. NULL is an open-ended series; the
  -- read-side expansion is bounded by its window (max 90 days) regardless, so an open series still
  -- terminates. A calendar date carried as 'YYYY-MM-DD' (the 0012 DATE convention), never an instant.
  until                DATE                                 NULL,
  created_by_user_id   CHAR(36)                             NOT NULL,
  created_at           DATETIME(3)                          NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_meeting_series_org_id (organization_id, id),
  -- 07-DATA-MODEL §9: the one read that exists — a tenant's series, oldest-first by id (UUIDv7 ≈
  -- creation order), which the keyset list walks.
  KEY ix_meeting_series_org_id_created (organization_id, id),
  -- "every 0 periods" is not a recurrence; a non-positive interval would make expansion
  -- non-terminating, so the engine refuses it rather than the service alone.
  CONSTRAINT ck_meeting_series_interval_positive CHECK (recurrence_interval >= 1),
  CONSTRAINT fk_meeting_series_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The actor. References users (id) without organization_id because a user is not tenant-owned —
  -- the same shape import_jobs.created_by_user_id uses (fk_import_jobs_creator).
  CONSTRAINT fk_meeting_series_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
