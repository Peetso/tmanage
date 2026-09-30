-- 0161_project_phases — FEAT: Project timeline phases (PROJ / module 8, x294).
--
-- Migration number: the pass-25 queue reserves 0161 for x294. The migrator applies files in
-- ascending numeric order and a gap is not an error (it rejects only a NEW file numbered *below*
-- an applied one), so 0161 on top of the base's highest migration is correct. If integration
-- renumbers the reservation, the integrator renumbers this file with it; nothing here depends on
-- the literal 0161 beyond the filename.
--
-- Governing sources: 22-SCREEN PRJ timeline/phases, 38-MODULE-MAP §Projects & portfolio,
-- 23-ERD milestones, 07-DATA-MODEL §9 (index prefixes lead with `organization_id`),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this table holds — two row kinds in one table, on purpose
--
-- A project manager groups a project's milestones (0048) into named, ordered phases so the
-- timeline reads as phases. The assignment of a milestone to a phase is recorded HERE, not on
-- `project_milestones` — this slice references milestone ids without editing the milestones
-- table, so it stays file-disjoint from every milestone-owning slice. One table therefore carries
-- two kinds of row, told apart by `milestone_id`:
--
--   * **Phase definition** (`milestone_id IS NULL`): a named, positioned column on the timeline.
--     Its handle is `(organization_id, project_id, name)`, which is UNIQUE — a duplicate phase
--     name within a project is a 409.
--   * **Milestone assignment** (`milestone_id IS NOT NULL`): a milestone placed into a phase.
--     `phase_id` points at a definition row's `id`; `name`/`position` are NULL. Its handle is
--     `(organization_id, milestone_id)`, which is UNIQUE — a milestone sits in at most one phase,
--     so re-assigning it is idempotent (the UPSERT rewrites `phase_id`).
--
-- MySQL treats NULLs as distinct in a UNIQUE index, so the many assignment rows (name NULL) do not
-- collide on `uq_project_phases_org_project_name`, and the many definition rows (milestone_id NULL)
-- do not collide on `uq_project_phases_org_milestone`. That is what lets both handles live on one
-- table.
--
-- ## Tenant-scoped and project-owned like every sibling
--
-- Both row kinds carry `project_id NOT NULL` (an assignment carries the milestone's project, so a
-- phase and its milestone can be checked to share a project without touching the milestones table).
-- The composite foreign key `fk_project_phases_project_tenant` binds `(organization_id, project_id)`
-- to `projects`, so a row can only ever name a project of its own tenant. The `milestone_id` and
-- `phase_id` references are advisory (resolved tenant-scoped in the service, which maps an unknown
-- or cross-tenant id to a 404 rather than a foreign-key 500); a hard FK to the milestones table is
-- deliberately absent to keep this slice from editing that table's schema.

CREATE TABLE project_phases (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- NOT NULL for both kinds: a definition's project, or an assignment's milestone's project.
  project_id         CHAR(36)     NOT NULL,
  -- Definition rows only; NULL on assignment rows (so they never collide on the name handle).
  name               VARCHAR(200) NULL,
  -- Definition rows only; the left-to-right order of the phase column. NULL on assignment rows.
  position           INT          NULL,
  -- Assignment rows only; the milestone being placed. NULL on definition rows.
  milestone_id       CHAR(36)     NULL,
  -- Assignment rows only; the definition row (`project_phases.id`) the milestone is placed into.
  phase_id           CHAR(36)     NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_project_phases_org_id (organization_id, id),
  -- Phase-definition dedupe: one name per project. Assignment rows have name NULL (distinct NULLs),
  -- so they do not participate.
  UNIQUE KEY uq_project_phases_org_project_name (organization_id, project_id, name),
  -- Milestone-assignment idempotency: one phase per milestone. Definition rows have milestone_id
  -- NULL (distinct NULLs), so they do not participate.
  UNIQUE KEY uq_project_phases_org_milestone (organization_id, milestone_id),
  -- The index the phase columns are listed by: this tenant's phases for this project, in order.
  -- Leads with `organization_id` per 07-DATA-MODEL §9.
  KEY ix_project_phases_org_project (organization_id, project_id, position),
  CONSTRAINT fk_project_phases_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A phase's identity is pinned at the engine. A direct SQL session bypasses the application layers,
-- so the guarantee that a row cannot be re-pointed at another project or tenant — nor a definition
-- row silently turned into an assignment row — must hold here too. `name`, `position` and `phase_id`
-- are the movable substance (rename a phase, reorder it, move a milestone between phases); the
-- identity columns are not.
DELIMITER $$

CREATE TRIGGER trg_project_phases_pin_identity
BEFORE UPDATE ON project_phases FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id)
     OR NOT (NEW.organization_id <=> OLD.organization_id)
     OR NOT (NEW.project_id <=> OLD.project_id)
     OR NOT (NEW.milestone_id <=> OLD.milestone_id)
     OR NOT (NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_phases identity columns are immutable';
  END IF;
END$$

DELIMITER ;
