-- 0220_client_request_defer_until — "Defer until" with a reminder on the triage screen (fq9-triage, A7).
--
-- The studio can park a client request until a date: the request moves to `deferred` (0006's
-- lifecycle, with its client-safe reason) and comes back to `triage` on that date — either by the
-- manager's "Reopen now" or by the worker's `--sweep-deferred-requests` job. When "Reopen it on this
-- date and remind me" was ticked, the sweep also leaves an in-app notice for the person who deferred.
--
-- * `defer_until`         — the instant the request comes back (midnight UTC of the chosen day),
--                           NULL when the request is not parked on a date.
-- * `reopen_reminder`     — 1 when the deferrer asked to be reminded on reopen.
-- * `deferred_by_user_id` — who deferred it, so the reminder has a recipient. NULL when no date.
--
-- All three are cleared when the request leaves `deferred` through the reopen path. The sweep's
-- predicate is `state = 'deferred' AND defer_until <= current_timestamp(3)`; the index below starts
-- with `state` because the sweep is cross-tenant (the worker runs as `tmanage_worker`, which already
-- holds SELECT + UPDATE on this table and INSERT on `notifications` in scripts/db/users.sql).
--
-- MariaDB-safe: plain nullable / defaulted columns and a plain index; no generated column, no CHECK,
-- no JSON, no functional index.

ALTER TABLE client_requests
  ADD COLUMN defer_until DATETIME(3) NULL AFTER linked_work_item_id,
  ADD COLUMN reopen_reminder TINYINT(1) NOT NULL DEFAULT 0 AFTER defer_until,
  ADD COLUMN deferred_by_user_id CHAR(36) NULL AFTER reopen_reminder,
  ADD KEY ix_client_requests_state_defer_until (state, defer_until);
