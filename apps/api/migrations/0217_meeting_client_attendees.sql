-- 0217_meeting_client_attendees — client people as meeting attendees (Figma 374:1985, BK5 gap).
--
-- `meeting_attendees` (0042) names an attendee by `membership_id`, a row of `memberships` — the
-- studio's own people. A client contact lives in `client_memberships` instead, so the meeting page's
-- "Clients can be added only from this project" had nowhere to write. This is that table: one row
-- per client person per meeting, beside the internal roster rather than inside it, so every query
-- and trigger 0042 already relies on keeps its meaning.
--
-- ## Only the meeting's project's client companies
--
-- The service resolves the client membership inside this tenant, requires it active and unexpired,
-- and requires its `client_organization_id` to be shared with the meeting's project
-- (`project_clients`). A client of another company is refused before the insert; the composite
-- foreign keys below refuse any cross-tenant meeting or client membership regardless.
--
-- ## What a client sees
--
-- The portal lists only meetings that carry a row here for the caller's own client membership, and
-- only while the project is still shared with their company.
--
-- MariaDB-safe: plain columns, an ENUM, composite foreign keys and a trigger; no generated column,
-- no CHECK, no functional index.

CREATE TABLE meeting_client_attendees (
  id                    CHAR(36)     NOT NULL,
  organization_id       CHAR(36)     NOT NULL,
  meeting_id            CHAR(36)     NOT NULL,
  -- The client person, by client membership row — the identity a client principal carries.
  client_membership_id  CHAR(36)     NOT NULL,
  rsvp                  ENUM('invited','accepted','declined') NOT NULL DEFAULT 'invited',
  created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_meeting_client_attendees_org_id (organization_id, id),
  -- One row per client person per meeting: a re-invite collides rather than duplicating.
  UNIQUE KEY uq_meeting_client_attendees_person (organization_id, meeting_id, client_membership_id),
  -- The meeting page's roster read.
  KEY ix_meeting_client_attendees_meeting (organization_id, meeting_id, id),
  -- The portal's "my meetings" read.
  KEY ix_meeting_client_attendees_member (organization_id, client_membership_id, meeting_id),
  CONSTRAINT fk_meeting_client_attendees_meeting
    FOREIGN KEY (organization_id, meeting_id) REFERENCES meetings (organization_id, id),
  CONSTRAINT fk_meeting_client_attendees_client_membership
    FOREIGN KEY (organization_id, client_membership_id) REFERENCES client_memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tenant, meeting and person are immutable; `rsvp` is the one column an UPDATE may change.
DELIMITER $$

CREATE TRIGGER trg_meeting_client_attendees_immutable
BEFORE UPDATE ON meeting_client_attendees FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_client_attendees.organization_id is immutable';
  END IF;
  IF NEW.meeting_id <> OLD.meeting_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_client_attendees.meeting_id is immutable';
  END IF;
  IF NEW.client_membership_id <> OLD.client_membership_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'meeting_client_attendees.client_membership_id is immutable';
  END IF;
END$$

DELIMITER ;
