-- 0305_milestone_timeline — 53-07 milestones and phases on the timeline (R19-c).
--
-- Governing sources: 53-FEATURE-GAPS-PLANNING-COLLAB.md "53-07" and §8 (a client payload carries
-- only title, committed date and status), 0048 (`project_milestones`), 0161 (`project_phases`),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §5-7 (composite tenant keys), ADR-0001.
--
-- ## What changes
--
-- * `project_milestones` gains the timeline's dates: `committed_on` (the date promised to the
--   client), `forecast_on` (the internal forecast — never leaves the internal routes),
--   `timeline_order` (manual order on the timeline), `client_title` (the client-safe name the
--   published copy uses instead of the internal title) and `version` (optimistic concurrency for
--   dragged dates; the service bumps it on every edit and answers 409 on a stale one).
-- * `project_phases` gains `starts_on`, `ends_on` and `color_token` for the phase band. They are
--   meaningful on definition rows only (`milestone_id IS NULL`); assignment rows keep NULL, which
--   the application checks — there is deliberately no CHECK (MariaDB parses it differently).
-- * NEW `milestone_client_projections`: publishing a milestone **copies** the allowlisted columns
--   (client title, committed date, client status, phase name) into this table, so the portal reads
--   only what was published and never the live internal row. Unpublishing deletes the copy, so the
--   app holds DELETE here. The `published` flag on `project_milestones` is still set for the
--   older readers.
--
-- MariaDB-safe like 0283/0298: no generated columns, no functional or descending index parts, no
-- CHECK; the trigger uses `<=>` so a NULL compares as a value.

ALTER TABLE project_milestones
  ADD COLUMN committed_on   DATE         NULL,
  ADD COLUMN forecast_on    DATE         NULL,
  ADD COLUMN timeline_order INT          NULL,
  ADD COLUMN client_title   VARCHAR(300) NULL,
  ADD COLUMN version        INT          NOT NULL DEFAULT 1;

ALTER TABLE project_phases
  ADD COLUMN starts_on   DATE        NULL,
  ADD COLUMN ends_on     DATE        NULL,
  ADD COLUMN color_token VARCHAR(32) NULL;

CREATE TABLE milestone_client_projections (
  id                   CHAR(36)     NOT NULL,
  organization_id      CHAR(36)     NOT NULL,
  project_id           CHAR(36)     NOT NULL,
  milestone_id         CHAR(36)     NOT NULL,
  -- `client_title ?? title` at publish time.
  client_title         VARCHAR(300) NOT NULL,
  committed_on         DATE         NULL,
  -- 'on_track' | 'at_risk' | 'done' — checked in the application.
  status               VARCHAR(16)  NOT NULL,
  phase_name           VARCHAR(200) NULL,
  published_by_user_id CHAR(36)     NOT NULL,
  published_at         DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mcp_org_id (organization_id, id),
  -- One client copy per milestone: a re-publish refreshes it.
  UNIQUE KEY uq_mcp_org_milestone (organization_id, milestone_id),
  KEY ix_mcp_org_project (organization_id, project_id),
  CONSTRAINT fk_mcp_milestone_tenant
    FOREIGN KEY (organization_id, milestone_id) REFERENCES project_milestones (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TRIGGER IF EXISTS trg_milestone_client_projections_org_immutable;

DELIMITER $$

CREATE TRIGGER trg_milestone_client_projections_org_immutable
BEFORE UPDATE ON milestone_client_projections FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id)
     OR NOT (NEW.milestone_id <=> OLD.milestone_id)
     OR NOT (NEW.project_id <=> OLD.project_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'milestone_client_projections identity columns are immutable';
  END IF;
END$$

DELIMITER ;
