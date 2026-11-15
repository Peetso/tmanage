-- 0348_calendar_sync_push_feeds — calendar sync: push channels, due-date mirror, ICS feed (53-14).
--
-- 1. `calendar_connections` gains the push channel (Google watch channel / Microsoft Graph
--    subscription) and the health columns:
--    - `watch_channel_id`: the channel id (Google) or subscription id (Graph). The public webhook
--      finds the connection by it on a bootstrap read, so it is unique (NULLs repeat freely).
--    - `watch_token_hash`: SHA-256 (hex) of the channel's secret token / clientState. The secret
--      itself is sent to the provider once and never stored.
--    - `watch_resource_id`: Google's resource id, needed to stop a channel and checked on every
--      notification. NULL for Graph.
--    - `watch_expires_at`: when the provider ends the channel; the sync job renews before it.
--    - `last_error_at`: when the last failed sync happened (the code is `last_error_code`).
--    - `mirror_due_dates`: the person's opt-in to see their work items' due dates as all-day events.
-- 2. `calendar_due_mirrors` (TENANT): which provider event mirrors which work item's due date for a
--    connection, and a fingerprint of what was written (title + date), so a change is re-sent once.
-- 3. `calendar_feed_tokens` (TENANT): a person's secret ICS feed address, stored as a SHA-256 hash
--    only (one per person per organization; rotating replaces the hash, revoking deletes the row).
--
-- MariaDB-safe (live is MariaDB 11.8): plain columns, DATETIME(3), TINYINT(1), no generated
-- columns, no CHECK, no functional or partial indexes, utf8mb4_unicode_ci. Additive only.

ALTER TABLE calendar_connections
  ADD COLUMN watch_channel_id VARCHAR(64) NULL,
  ADD COLUMN watch_token_hash CHAR(64) NULL,
  ADD COLUMN watch_resource_id VARCHAR(255) NULL,
  ADD COLUMN watch_expires_at DATETIME(3) NULL,
  ADD COLUMN last_error_at DATETIME(3) NULL,
  ADD COLUMN mirror_due_dates TINYINT(1) NOT NULL DEFAULT 0,
  ADD UNIQUE KEY uq_calendar_connections_watch (watch_channel_id);

CREATE TABLE calendar_due_mirrors (
  id                        CHAR(36)       NOT NULL,
  organization_id           CHAR(36)       NOT NULL,
  connection_id             CHAR(36)       NOT NULL,
  work_item_id              CHAR(36)       NOT NULL,
  external_event_id         VARCHAR(512)   NOT NULL,
  fingerprint               CHAR(64)       NOT NULL,
  created_at                DATETIME(3)    NOT NULL,
  updated_at                DATETIME(3)    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_calendar_due_mirrors_org_id (organization_id, id),
  UNIQUE KEY uq_calendar_due_mirrors_item (organization_id, connection_id, work_item_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE calendar_feed_tokens (
  id                        CHAR(36)       NOT NULL,
  organization_id           CHAR(36)       NOT NULL,
  user_id                   CHAR(36)       NOT NULL,
  token_hash                CHAR(64)       NOT NULL,
  created_at                DATETIME(3)    NOT NULL,
  last_used_at              DATETIME(3)    NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_calendar_feed_tokens_org_id (organization_id, id),
  UNIQUE KEY uq_calendar_feed_tokens_person (organization_id, user_id),
  UNIQUE KEY uq_calendar_feed_tokens_hash (token_hash)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
