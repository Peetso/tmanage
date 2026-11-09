-- 0341_time_auto_tracking — automatic time tracking from whole-computer activity (FIX 2026-11-10).
--
-- Peter: "the timer automatic starts when the pc is active ... and stops when it's not active, not
-- the page i mean the whole pc". The desktop app (Electron powerMonitor) or Chrome/Edge (Idle
-- Detection API) reports only "how many seconds since the last input"; the server joins those
-- heartbeats into sessions and files each finished session as a `work_item_time_logs` entry with
-- `source = 'automatic'` (a closed list checked in the application, `modules/time/time-rules.ts`).
--
-- `time_auto_tracking` (TENANT, new) — one row per membership:
--   - the person's own switch ("Track my time automatically") and idle threshold (1..30 minutes,
--     default 5, checked in the application);
--   - the current task ("working on now"): a work item and its project, or neither (the time is
--     kept as unassigned work time, assignable later from the timesheet);
--   - the open session: when it started, the last moment of real activity and when the server last
--     heard a heartbeat. All three are this server's clock, never a client value. NULL = no open
--     session. The row stays when the session closes; only the three session columns are cleared.
-- `user_id` is kept beside `membership_id` the way `time_timers` keeps it.
--
-- No screenshots, keystrokes, app or window names or URLs are stored anywhere: only the switch, the
-- threshold, the task and three times.
--
-- MariaDB-safe (live is MariaDB 11.8): plain columns, DATETIME(3), no CHECK, no generated column, no
-- JSON default, no functional index, no foreign key (the 0257 / 0265 convention: the service resolves
-- the work item and project tenant-scoped before it writes, and a purged work item must not be
-- blocked by somebody's current task), utf8mb4_unicode_ci.
--
-- The company owner's policy (off / optional / required) is an `org_settings` key
-- (`auto_time_tracking`), no column.

CREATE TABLE time_auto_tracking (
  id                     CHAR(36)          NOT NULL,
  organization_id        CHAR(36)          NOT NULL,
  membership_id          CHAR(36)          NOT NULL,
  user_id                CHAR(36)          NOT NULL,
  enabled                TINYINT(1)        NOT NULL DEFAULT 0,
  idle_threshold_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 5,
  work_item_id           CHAR(36)          NULL,
  project_id             CHAR(36)          NULL,
  session_started_at     DATETIME(3)       NULL,
  last_active_at         DATETIME(3)       NULL,
  last_heartbeat_at      DATETIME(3)       NULL,
  created_at             DATETIME(3)       NOT NULL,
  updated_at             DATETIME(3)       NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_time_auto_tracking_org_id (organization_id, id),
  -- One row per membership: the upsert key and the one-open-session invariant.
  UNIQUE KEY uq_time_auto_tracking_org_member (organization_id, membership_id),
  -- The team view: who was heard from recently.
  KEY ix_time_auto_tracking_org_heartbeat (organization_id, last_heartbeat_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
