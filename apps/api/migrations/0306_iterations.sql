-- 0306_iterations — 53-21 iterations (light sprints) and optional story points (R19-d).
--
-- Governing sources: 53-FEATURE-GAPS-PLANNING-COLLAB.md "53-21" (§7.1, §8), 0283 (the working
-- calendar the default dates and days-left count in), 25-AUTHORIZATION-AND-TENANT-ISOLATION §5-7
-- (composite tenant keys), ADR-0001.
--
-- ## What changes
--
-- * `iterations` (NEW, tenant): a named, dated slice of one project's work. `status` is
--   planned | active | completed, checked in the application; `completed_at` is set once by the
--   complete-and-roll transaction, with the counts it moved and left (`moved_count`, `left_count`)
--   so a repeated complete is idempotent and answers the same. No DELETE grant: an iteration is planning history.
-- * `work_items.iteration_id` / `iteration_assigned_at`: the iteration an item is in and when it
--   joined (the burndown's scope line is computed from this; there is no snapshot table).
--   `work_items.points`: optional story points, 0..100, only when the project has points on.
-- * `projects.points_enabled`: the per-project switch for points (off by default).
--
-- None of these columns is ever read by a client projection (portal, public links): those build
-- their views field by field and never name them.
--
-- MariaDB-safe: no generated columns, no functional or descending index parts, no CHECK; the
-- trigger uses `<=>` so a NULL compares as a value.

CREATE TABLE iterations (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  project_id      CHAR(36)     NOT NULL,
  name            VARCHAR(120) NOT NULL,
  goal            VARCHAR(300) NULL,
  starts_on       DATE         NOT NULL,
  ends_on         DATE         NOT NULL,
  -- planned | active | completed (application-checked).
  status          VARCHAR(12)  NOT NULL DEFAULT 'planned',
  completed_at    DATETIME(3)  NULL,
  -- What complete-and-roll did, kept so a repeated complete answers the same counts.
  moved_count     INT          NULL,
  left_count      INT          NULL,
  created_by      CHAR(36)     NOT NULL,
  created_at      DATETIME(3)  NOT NULL,
  updated_at      DATETIME(3)  NOT NULL,
  version         INT          NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_iterations_org_id (organization_id, id),
  KEY ix_iterations_org_project_starts (organization_id, project_id, starts_on),
  CONSTRAINT fk_iterations_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_iterations_org_immutable
BEFORE UPDATE ON iterations FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'iterations.organization_id is immutable';
  END IF;
END$$

DELIMITER ;

ALTER TABLE work_items
  ADD COLUMN iteration_id          CHAR(36)    NULL,
  ADD COLUMN points                SMALLINT    NULL,
  ADD COLUMN iteration_assigned_at DATETIME(3) NULL,
  ADD KEY ix_wi_org_iteration (organization_id, iteration_id),
  ADD CONSTRAINT fk_wi_iteration
    FOREIGN KEY (organization_id, iteration_id) REFERENCES iterations (organization_id, id);

ALTER TABLE projects
  ADD COLUMN points_enabled TINYINT(1) NOT NULL DEFAULT 0;
