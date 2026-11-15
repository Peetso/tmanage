-- 0353_meeting_join_attendance — meeting join flow, attendance and quick room (53-12).
--
-- `meeting_call_links` (TENANT): the call a meeting uses when it is not the Meet/Teams link minted
-- by the organizer's connected calendar (0237 `meeting_external_events.join_url`). One row per
-- meeting. `kind` is `link` (a Meet/Teams/Zoom/Webex/Whereby/Jitsi link the organizer pasted) or
-- `quick_room` (a public meet.jit.si room with a 128-bit random name, made by TManage without any
-- key or paid service). The API validates `url` against an allow-list of meeting hosts before it
-- is stored and again before it is handed out; the server never fetches it.
--
-- `meeting_attendance` (TENANT): who joined. One row per (meeting, person): the first Join click
-- inside the join window inserts it, a later click only moves `last_joined_at` and counts. The
-- organizer may correct a row by hand (`source` = `manual`, `marked_by_user_id`). A person is a
-- user id (members and client people both have one); `attendee_kind` says which side.
--
-- MariaDB-safe (live is MariaDB 11.8): plain columns, DATETIME(3), no generated columns, no CHECK,
-- no JSON, no functional or partial indexes, utf8mb4_unicode_ci. Composite foreign keys tie each row
-- to a meeting of its own tenant. Additive only: old code never reads these tables.

CREATE TABLE meeting_call_links (
  id                  CHAR(36)       NOT NULL,
  organization_id     CHAR(36)       NOT NULL,
  meeting_id          CHAR(36)       NOT NULL,
  -- `link` or `quick_room`.
  kind                VARCHAR(16)    NOT NULL,
  url                 VARCHAR(1024)  NOT NULL,
  set_by_user_id      CHAR(36)       NOT NULL,
  created_at          DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_meeting_call_links_org_id (organization_id, id),
  UNIQUE KEY uq_meeting_call_links_meeting (organization_id, meeting_id),
  CONSTRAINT fk_meeting_call_links_meeting
    FOREIGN KEY (organization_id, meeting_id) REFERENCES meetings (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE meeting_attendance (
  id                  CHAR(36)       NOT NULL,
  organization_id     CHAR(36)       NOT NULL,
  meeting_id          CHAR(36)       NOT NULL,
  user_id             CHAR(36)       NOT NULL,
  -- `member` or `client`.
  attendee_kind       VARCHAR(8)     NOT NULL,
  -- `present` or `absent`.
  status              VARCHAR(8)     NOT NULL,
  -- `join_click` or `manual`.
  source              VARCHAR(16)    NOT NULL,
  first_joined_at     DATETIME(3)    NULL,
  last_joined_at      DATETIME(3)    NULL,
  join_count          INT UNSIGNED   NOT NULL DEFAULT 0,
  marked_by_user_id   CHAR(36)       NULL,
  created_at          DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_meeting_attendance_org_id (organization_id, id),
  UNIQUE KEY uq_meeting_attendance_person (organization_id, meeting_id, user_id),
  CONSTRAINT fk_meeting_attendance_meeting
    FOREIGN KEY (organization_id, meeting_id) REFERENCES meetings (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
