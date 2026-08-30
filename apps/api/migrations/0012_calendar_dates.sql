-- 0012: calendar dates become DATE columns.
--
-- Four columns held `DATETIME(3)` values that every writer filled with midnight UTC for a
-- value that is a calendar date: `projects.forecast_at` and `projects.committed_at` (a
-- target and a promise, both picked from a date field), and `client_requests.desired_at`
-- and `client_requests.committed_at` (what the client asked for and what the studio agreed
-- to, both picked from a date field). Storing midnight UTC made every reader west of UTC
-- see the date a day early once `Intl.DateTimeFormat` rendered the instant in their zone --
-- recorded as WEB-004 gap 6 and a PROJ-002 gap since those tickets landed.
--
-- The planning note scoping this migration named three columns; `client_requests.committed_at`
-- is the fourth, converted with them because the triage screen fills it exactly the way the
-- other three are filled, and leaving it DATETIME would keep the "two conventions that
-- disagree" that gap 6 warned against.
--
-- DATETIME -> DATE keeps the date part and drops the time part. Every stored value is
-- midnight UTC (every writer went through `parseTargetDate` or the screens' start-of-day
-- conversion), so the date part *is* the calendar date that was meant; the truncation is
-- proven against a live engine in `migrator.db.test.ts` rather than assumed here.
--
-- The commitment-coherence triggers on `client_requests` (0006) reference `committed_at` by
-- name only, so they survive the type change unaltered.

ALTER TABLE projects
  MODIFY committed_at DATE NULL,
  MODIFY forecast_at DATE NULL;

ALTER TABLE client_requests
  MODIFY desired_at DATE NULL,
  MODIFY committed_at DATE NULL;
