-- 0213_meeting_ends_at — a meeting's end instant (audit gap 8, COL-06 / COL-09).
--
-- `0029_meetings.sql` gave a meeting a start and nothing else, so the schedule form could not ask
-- for a length and the ICS export invented a fixed hour. This adds `ends_at`: a nullable
-- `DATETIME(3)` UTC instant beside `starts_at`. NULL means "no end recorded" (every row created
-- before this migration), never a zero-length meeting.
--
-- "End after start" is held by the API (create and the new PATCH both refuse `ends_at <= starts_at`)
-- rather than by a CHECK constraint: the live host is MariaDB, and this schema keeps to the syntax
-- both engines read the same way. No index: a meeting is listed by `(organization_id, project_id,
-- starts_at)` and nothing filters on its end.
--
-- 0029's `trg_meetings_immutable` pins organization_id/project_id/created_by_user_id and leaves the
-- rest editable, so `ends_at` is editable without touching the trigger.

ALTER TABLE meetings
  ADD COLUMN ends_at DATETIME(3) NULL AFTER starts_at;
