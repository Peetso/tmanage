-- 0363_client_journey_steps — 52-27 client journeys: the steps a client works through on one
-- project (fill a form, send files, sign, accept a meeting).
--
-- The portal stepper (52-27 first slice) is derived from published milestones and the client's
-- open review. This table adds the client's own steps. A step stores no content of its own: it
-- names the object the client acts on (`ref_id`: a work form, a signature request or a meeting;
-- NULL for an upload step or a step not linked yet) and, for a form step, the `form_submissions`
-- row the portal stored (`evidence_id`). Whether a step is done is decided by the server from that
-- evidence (a stored submission, a completed upload, a signed request, an accepted meeting),
-- never from a flag a client could send.
--
-- MariaDB-safe: plain columns, a CHECK on a closed list, composite FKs to existing unique keys
-- (`uq_project_clients_identity` binds the step to a client the project is shared with), and an
-- immutability trigger in the 0357 shape. No generated column.

CREATE TABLE client_journey_steps (
  id                     CHAR(36)          NOT NULL,
  organization_id        CHAR(36)          NOT NULL,
  project_id             CHAR(36)          NOT NULL,
  -- The client company this step is for. Every portal read and submit filters on the caller's own
  -- client organization, so one client never sees or completes another client's step.
  client_organization_id CHAR(36)          NOT NULL,
  -- Order on the client's path, 1-based, unique per project and client.
  sequence               SMALLINT UNSIGNED NOT NULL,
  kind                   VARCHAR(12)       NOT NULL,
  title                  VARCHAR(200)      NOT NULL,
  ref_id                 CHAR(36)          NULL,
  evidence_id            CHAR(36)          NULL,
  created_by             CHAR(36)          NOT NULL,
  created_at             DATETIME(3)       NOT NULL,
  updated_at             DATETIME(3)       NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_client_journey_steps_org_id (organization_id, id),
  UNIQUE KEY uq_client_journey_steps_order (organization_id, project_id, client_organization_id, sequence),
  CONSTRAINT ck_client_journey_steps_kind CHECK (kind IN ('form', 'upload', 'sign', 'meeting')),
  CONSTRAINT fk_client_journey_steps_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The client must be one the project is shared with, in the same tenant. Withdrawing the share
  -- removes that client's steps with it: the client no longer sees the project at all.
  CONSTRAINT fk_client_journey_steps_project_client
    FOREIGN KEY (organization_id, project_id, client_organization_id)
    REFERENCES project_clients (organization_id, project_id, client_organization_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_client_journey_steps_evidence
    FOREIGN KEY (organization_id, evidence_id) REFERENCES form_submissions (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_client_journey_steps_immutable
BEFORE UPDATE ON client_journey_steps FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_journey_steps.organization_id is immutable';
  END IF;
  IF NEW.project_id <> OLD.project_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_journey_steps.project_id is immutable';
  END IF;
  IF NEW.client_organization_id <> OLD.client_organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_journey_steps.client_organization_id is immutable';
  END IF;
  IF NEW.kind <> OLD.kind THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_journey_steps.kind is immutable';
  END IF;
END$$

DELIMITER ;
