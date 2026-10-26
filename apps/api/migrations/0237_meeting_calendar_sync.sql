-- 0237_meeting_calendar_sync — meetings connected to Google Calendar / Meet (and, in slice B,
-- Microsoft Outlook / Teams). Plan: wave-2026-10-26/meetings/PLAN.md.
--
-- ## What this migration is for
--
-- A meeting can now carry every option a Google Calendar event has (all-day, time zone, location,
-- recurrence, visibility, busy/free, colour, video conference, reminders, guest permissions), be
-- cancelled, invite people by free email, and carry Drive/OneDrive attachments. When its organizer
-- has connected their own calendar, TManage creates the event in that calendar, which sends the
-- invitations and mints the Meet/Teams link, and pulls answers and outside edits back.
--
--   * `meetings` gains the event options and `cancelled_at`. `agenda_note` stays the description.
--   * `meeting_attendees` / `meeting_client_attendees` gain `optional`, and `rsvp` gains
--     `tentative` (Google "maybe", Outlook "tentatively accepted").
--   * `calendar_connections` — ONE PERSON's connection to their own Google or Microsoft calendar
--     (not the company Drive connection). One row per (organization, user, provider). The refresh
--     token is AES-256-GCM under `AUTH_MFA_SEED_KEYS`, bound to org + user + provider.
--   * `meeting_external_events` — which provider event a meeting is (one per provider).
--   * `meeting_guests` — people invited by email who are not TManage users.
--   * `meeting_attachments` — Drive/OneDrive files attached to a meeting. Removing is soft.
--
-- ## Tenancy
--
-- All four new tables are tenant-owned: `organization_id` on every row, the `(organization_id, id)`
-- key, registered in TENANT_TABLES. Rows that name a meeting do so with a composite foreign key, so
-- they can only name a meeting of their own tenant. Identity columns are pinned by triggers.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns and keys only: no generated columns, no CHECK, no JSON, no expression defaults
-- beyond CURRENT_TIMESTAMP(3). The widest key, `uq_meeting_guests_email`, is
-- 144 + 144 + 1016 = 1304 bytes (inside the 3072-byte DYNAMIC limit).
-- Additive only: old code ignores the new columns, never reads the new tables, and never writes
-- `tentative` (an old roster read shows it as an unknown value; no restore is needed).

ALTER TABLE meetings
  ADD COLUMN all_day                 TINYINT(1)    NOT NULL DEFAULT 0,
  -- IANA zone the times were chosen in (e.g. `Africa/Cairo`); NULL = UTC.
  ADD COLUMN time_zone               VARCHAR(64)   NULL,
  ADD COLUMN location                VARCHAR(512)  NULL,
  -- One RFC 5545 RRULE body without the `RRULE:` prefix, e.g. `FREQ=WEEKLY;BYDAY=MO,WE`.
  ADD COLUMN recurrence_rrule        VARCHAR(1024) NULL,
  -- `default`, `public`, `private` or `confidential`.
  ADD COLUMN visibility              VARCHAR(16)   NOT NULL DEFAULT 'default',
  -- `busy` or `free`.
  ADD COLUMN show_as                 VARCHAR(8)    NOT NULL DEFAULT 'busy',
  -- Google event colour `1`..`11`; NULL = the calendar's colour.
  ADD COLUMN color_id                VARCHAR(8)    NULL,
  -- `none`, `google_meet` or `teams`.
  ADD COLUMN conference              VARCHAR(16)   NOT NULL DEFAULT 'none',
  -- Compact list `popup:10,email:1440` (at most 5); NULL = the calendar's default reminders.
  ADD COLUMN reminders               VARCHAR(255)  NULL,
  ADD COLUMN guests_can_modify       TINYINT(1)    NOT NULL DEFAULT 0,
  ADD COLUMN guests_can_invite_others TINYINT(1)   NOT NULL DEFAULT 1,
  ADD COLUMN guests_can_see_others   TINYINT(1)    NOT NULL DEFAULT 1,
  ADD COLUMN cancelled_at            DATETIME(3)   NULL;

ALTER TABLE meeting_attendees
  ADD COLUMN optional TINYINT(1) NOT NULL DEFAULT 0,
  MODIFY rsvp ENUM('invited','accepted','declined','tentative') NOT NULL DEFAULT 'invited';

ALTER TABLE meeting_client_attendees
  ADD COLUMN optional TINYINT(1) NOT NULL DEFAULT 0,
  MODIFY rsvp ENUM('invited','accepted','declined','tentative') NOT NULL DEFAULT 'invited';

CREATE TABLE calendar_connections (
  id                 CHAR(36)      NOT NULL,
  organization_id    CHAR(36)      NOT NULL,
  user_id            CHAR(36)      NOT NULL,
  -- `google` or `microsoft`.
  provider           VARCHAR(16)   NOT NULL,
  -- `connected`, `error` or `disconnected`.
  status             VARCHAR(16)   NOT NULL,
  account_email      VARCHAR(254)  NULL,
  -- AES-256-GCM envelope; NULL once disconnected.
  refresh_token_enc  TEXT          NULL,
  granted_scopes     VARCHAR(512)  NULL,
  calendar_id        VARCHAR(255)  NOT NULL DEFAULT 'primary',
  -- Google `nextSyncToken` or Graph `deltaLink`; NULL = next pull is a full window read.
  sync_cursor        VARCHAR(2048) NULL,
  last_error_code    VARCHAR(64)   NULL,
  last_synced_at     DATETIME(3)   NULL,
  connected_at       DATETIME(3)   NULL,
  disconnected_at    DATETIME(3)   NULL,
  created_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_calendar_connections_org_id (organization_id, id),
  UNIQUE KEY uq_calendar_connections_person (organization_id, user_id, provider),
  KEY ix_calendar_connections_status (status, provider),
  CONSTRAINT fk_calendar_connections_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_calendar_connections_user
    FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE meeting_external_events (
  id                    CHAR(36)      NOT NULL,
  organization_id       CHAR(36)      NOT NULL,
  meeting_id            CHAR(36)      NOT NULL,
  -- The organizer's connection the event lives in.
  connection_id         CHAR(36)      NOT NULL,
  provider              VARCHAR(16)   NOT NULL,
  external_event_id     VARCHAR(255)  NULL,
  external_calendar_id  VARCHAR(255)  NULL,
  ical_uid              VARCHAR(255)  NULL,
  join_url              VARCHAR(1024) NULL,
  html_link             VARCHAR(1024) NULL,
  -- Google etag / Graph changeKey of the last version seen.
  external_version      VARCHAR(255)  NULL,
  -- `pending`, `synced`, `error` or `deleted`.
  sync_status           VARCHAR(16)   NOT NULL DEFAULT 'pending',
  last_error_code       VARCHAR(64)   NULL,
  last_pushed_at        DATETIME(3)   NULL,
  last_pulled_at        DATETIME(3)   NULL,
  created_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_meeting_external_events_org_id (organization_id, id),
  UNIQUE KEY uq_meeting_external_events_meeting (organization_id, meeting_id, provider),
  KEY ix_meeting_external_events_event (organization_id, connection_id, external_event_id),
  CONSTRAINT fk_meeting_external_events_meeting
    FOREIGN KEY (organization_id, meeting_id) REFERENCES meetings (organization_id, id),
  CONSTRAINT fk_meeting_external_events_connection
    FOREIGN KEY (organization_id, connection_id)
    REFERENCES calendar_connections (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE meeting_guests (
  id               CHAR(36)      NOT NULL,
  organization_id  CHAR(36)      NOT NULL,
  meeting_id       CHAR(36)      NOT NULL,
  -- Stored lower-cased by the API.
  email            VARCHAR(254)  NOT NULL,
  display_name     VARCHAR(190)  NULL,
  optional         TINYINT(1)    NOT NULL DEFAULT 0,
  -- `invited`, `accepted`, `declined` or `tentative`.
  rsvp             VARCHAR(16)   NOT NULL DEFAULT 'invited',
  comment          VARCHAR(512)  NULL,
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_meeting_guests_org_id (organization_id, id),
  UNIQUE KEY uq_meeting_guests_email (organization_id, meeting_id, email),
  CONSTRAINT fk_meeting_guests_meeting
    FOREIGN KEY (organization_id, meeting_id) REFERENCES meetings (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE meeting_attachments (
  id                   CHAR(36)      NOT NULL,
  organization_id      CHAR(36)      NOT NULL,
  meeting_id           CHAR(36)      NOT NULL,
  -- `google_drive` or `onedrive`.
  provider             VARCHAR(16)   NOT NULL,
  file_id              VARCHAR(255)  NOT NULL,
  drive_id             VARCHAR(128)  NULL,
  title                VARCHAR(255)  NOT NULL,
  mime_type            VARCHAR(190)  NOT NULL,
  web_url              VARCHAR(1024) NULL,
  attached_by_user_id  CHAR(36)      NOT NULL,
  removed_at           DATETIME(3)   NULL,
  created_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_meeting_attachments_org_id (organization_id, id),
  KEY ix_meeting_attachments_meeting (organization_id, meeting_id, id),
  CONSTRAINT fk_meeting_attachments_meeting
    FOREIGN KEY (organization_id, meeting_id) REFERENCES meetings (organization_id, id),
  CONSTRAINT fk_meeting_attachments_user
    FOREIGN KEY (attached_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_calendar_connections_immutable
BEFORE UPDATE ON calendar_connections FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.user_id <> OLD.user_id
     OR NEW.provider <> OLD.provider THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'calendar_connections identity columns are immutable';
  END IF;
END$$

CREATE TRIGGER trg_meeting_external_events_immutable
BEFORE UPDATE ON meeting_external_events FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.meeting_id <> OLD.meeting_id
     OR NEW.provider <> OLD.provider THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_external_events identity columns are immutable';
  END IF;
END$$

CREATE TRIGGER trg_meeting_guests_immutable
BEFORE UPDATE ON meeting_guests FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.meeting_id <> OLD.meeting_id
     OR NEW.email <> OLD.email THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_guests identity columns are immutable';
  END IF;
END$$

CREATE TRIGGER trg_meeting_attachments_immutable
BEFORE UPDATE ON meeting_attachments FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.meeting_id <> OLD.meeting_id
     OR NEW.file_id <> OLD.file_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_attachments identity columns are immutable';
  END IF;
END$$

DELIMITER ;
