-- 0271_session_idle_limit — R3 idle sign-out (PETER-REQUESTS-2026-10-31 R3).
--
-- A company may now sign people out after inactivity (`org_policies.policy_json`
-- `idle_signout_minutes`: 0 = Off, 30, 60, 240 or 480; default 480). The policy lives in the
-- policy document and needs no column; what needs one is the refresh path, which knows the
-- session but not the company. `sessions.idle_limit_minutes` carries the strictest limit of any
-- company the session has acted in (stamped by the tenant guard, only ever lowered), so
-- `SessionService.refresh` can refuse a session idle longer than it, measured from
-- `coalesce(rotated_at, created_at)` by the database clock. NULL = no limit seen yet.
--
-- MariaDB 11.8 / MySQL 8 safe: a plain nullable column, no default expression, no generated
-- column. The API already holds UPDATE on `sessions` (users.sql), so no grant changes.

ALTER TABLE sessions
  ADD COLUMN idle_limit_minutes SMALLINT UNSIGNED NULL;
