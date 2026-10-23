-- 0218_invitation_projects_note — "Add to projects" and "Personal note" on an invitation (r-invite, A1).
--
-- The invite dialog (Figma 374:1985, r-invite) lets the inviter put the new person on projects
-- straight away and write a short welcome. Neither has a home in 0005's `invitations`:
--
-- * `invitations.note` — the inviter's own words, at most 500 characters, NULL when none. It is
--   personal text the invitee reads; it never reaches the audit trail (prose is not audit
--   metadata).
-- * `invitation_projects` — one row per project the person joins **on acceptance**. Nothing is
--   granted at issue time: the invitee is not a member yet, and a revoked or expired invitation must
--   leave no project membership behind. Acceptance reads these rows and adds a
--   `project_memberships` row for each project still live in the tenant.
--
-- Internal invitations only: the service refuses projects on a client invitation (a client reaches
-- a project through `project_clients`, not a project membership).
--
-- The composite foreign keys refuse any project or invitation from another tenant at the storage
-- layer, whatever the service does.
--
-- MariaDB-safe: a plain nullable column, plain columns, composite foreign keys and a trigger; no
-- generated column, no CHECK, no JSON, no functional index.

ALTER TABLE invitations
  ADD COLUMN note VARCHAR(500) NULL AFTER role;

CREATE TABLE invitation_projects (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  invitation_id    CHAR(36)     NOT NULL,
  project_id       CHAR(36)     NOT NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_invitation_projects_org_id (organization_id, id),
  -- One row per project per invitation: a repeated id in the request collides rather than doubling.
  UNIQUE KEY uq_invitation_projects_pair (organization_id, invitation_id, project_id),
  KEY ix_invitation_projects_project (organization_id, project_id),
  CONSTRAINT fk_invitation_projects_invitation
    FOREIGN KEY (organization_id, invitation_id) REFERENCES invitations (organization_id, id),
  CONSTRAINT fk_invitation_projects_project
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rows are written once at issue and never changed: every identity column is immutable.
DELIMITER $$

CREATE TRIGGER trg_invitation_projects_immutable
BEFORE UPDATE ON invitation_projects FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'invitation_projects.organization_id is immutable';
  END IF;
  IF NEW.invitation_id <> OLD.invitation_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'invitation_projects.invitation_id is immutable';
  END IF;
  IF NEW.project_id <> OLD.project_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'invitation_projects.project_id is immutable';
  END IF;
END$$

DELIMITER ;
