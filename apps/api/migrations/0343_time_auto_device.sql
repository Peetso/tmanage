-- 0343_time_auto_device — where a person's automatic tracking really runs (live check 0186c261,
-- TIMER item 17).
--
-- The owner asked to see, per person, whether tracking can run at all: in the TManage desktop app,
-- in a browser that allowed idle detection, in a browser that has not allowed it yet, or on no
-- device. The web page (in the desktop app or in a browser) reports which of those it is when it
-- opens and whenever the browser permission changes; nothing else about the device is stored (no
-- name, address, app or browser version).
--
-- `time_auto_tracking` (TENANT, 0341) gains:
--   - `device_kind`: `desktop` | `browser_allowed` | `browser_prompt` | `browser_blocked` |
--     `browser_unsupported` (a closed list checked in the application, `time-auto-rules.ts`);
--     NULL = never reported;
--   - `device_seen_at`: when this server last received that report (its own clock).
-- The latest report wins: one row per membership, so a person on two devices shows the last one
-- that reported.
--
-- MariaDB-safe (live is MariaDB 11.8): two plain NULL columns, no default expression, no CHECK.

ALTER TABLE time_auto_tracking
  ADD COLUMN device_kind    VARCHAR(24) NULL AFTER last_heartbeat_at,
  ADD COLUMN device_seen_at DATETIME(3) NULL AFTER device_kind;
