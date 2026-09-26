-- 0040_project_objectives — a project's objectives (PROJ / module 8, x124 slice 1).
--
-- Migration number: the highest migration on this branch's base (pass-18 master f014d6c) is
-- 0038_decision_supersessions. 0039 is reserved by x119 on a sibling branch not yet integrated, so
-- this file is named 0040 to sit above that reservation — the number NEXT-SCOPES-11 reserved for
-- x124. The migrator applies files in ascending numeric order and a gap is not an error (it rejects
-- only a NEW file numbered *below* an applied one), so 0040 on top of 0038 is correct on this base.
-- If integration renumbers the reservation, the integrator renumbers this file with it; nothing here
-- depends on the literal 0040 beyond the filename.
--
-- Governing sources: 38-MODULE-MAP §Projects & portfolio ("objectives, portfolio roll-up"),
-- 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §Projects (project objectives/OKR screens),
-- 23-ERD-AND-STATE-MACHINES §2 (`PROJECT ||--o{ …` project-owned records), 07-DATA-MODEL §9 (index
-- prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant
-- keys).
--
-- ## What this migration is for
--
-- The project overview advertises objectives; there was no table to hold them. This is a project's
-- objectives at rest: a name, an optional description and target, a short status, who created it and
-- when. It is deliberately *not* org-level OKRs, key results, or an objective→work linkage — those
-- are deferred (NEXT-SCOPES-12). This table carries only what a project objective *is*.
--
-- ## Project-owned, and tenant-scoped like every sibling
--
-- `project_objectives.project_id` is `NOT NULL`: an objective belongs to a project, the way a meeting,
-- a document and a decision do. Authorization is relation-gated on the project (see
-- `ProjectObjectivesService`), so an objective with no project would have no relation to check. The
-- composite foreign key `fk_project_objectives_project_tenant` binds `(organization_id, project_id)`
-- to `projects`, so an objective can only ever name a project of its own tenant — a cross-tenant
-- project id does not exist as a pair even when both ids exist individually.
--
-- ## Status may move; nothing else may
--
-- Unlike the append-only registers (`decisions` before 0038, `meeting_notes`, `client_projections`),
-- an objective has a lifecycle: `open → met` or `open → missed`. So the runtime credential holds
-- UPDATE (see `users.sql`), and the `BEFORE UPDATE` trigger is a *column-pinning* one from birth —
-- `status` may change, and every other column is pinned at the engine, the form `decisions` reached
-- only after 0038 relaxed it. A direct SQL session bypasses ADR-0001's application layers, so the
-- pin lives here too. The transition itself is guarded in the service (an illegal one is a 409 with
-- no write); the trigger only guarantees no *other* column is rewritten under any path.

CREATE TABLE project_objectives (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- NOT NULL. An objective belongs to a project; see the note above.
  project_id         CHAR(36)     NOT NULL,
  -- `projects.name` / `meetings.title` are short handles; an objective's name is the same kind.
  name               VARCHAR(300) NOT NULL,
  -- Optional prose describing the objective. TEXT and nullable — an objective may be a one-liner.
  description        TEXT         NULL,
  -- Optional target the objective aims at, as a short handle a person types (e.g. "95% on-time",
  -- "ship by Q3"). Not a number: a target is expressed in the project's own terms this slice.
  target             VARCHAR(300) NULL,
  -- Where the objective stands. `open` at creation; the lifecycle transitions to `met` or `missed`.
  status             ENUM('open','met','missed') NOT NULL DEFAULT 'open',
  -- The person who created the objective — the service passes `context.userId`.
  created_by         CHAR(36)     NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child (a key
  -- result, an objective→work edge) can reference this row without a cross-tenant path.
  UNIQUE KEY uq_project_objectives_org_id (organization_id, id),
  -- The index a project's objectives are listed by: this tenant's objectives for this project, in
  -- creation order (the list reads `created_at ASC`). Leads with `organization_id` per 07-DATA-MODEL
  -- §9.
  KEY ix_project_objectives_org_project (organization_id, project_id, created_at),
  CONSTRAINT fk_project_objectives_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_project_objectives_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An objective's substance is pinned at the engine; only `status` may move. The trigger refuses an
-- UPDATE that changes any other column, the reason `decisions` (0038) carries a column-pinning
-- trigger — a direct SQL session bypasses the application layers, so the guarantee that "who set the
-- objective and its wording do not change under a status transition" must hold at the engine too.
DELIMITER $$

CREATE TRIGGER trg_project_objectives_pin_columns
BEFORE UPDATE ON project_objectives FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id)
     OR NOT (NEW.organization_id <=> OLD.organization_id)
     OR NOT (NEW.project_id <=> OLD.project_id)
     OR NOT (NEW.name <=> OLD.name)
     OR NOT (NEW.description <=> OLD.description)
     OR NOT (NEW.target <=> OLD.target)
     OR NOT (NEW.created_by <=> OLD.created_by)
     OR NOT (NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_objectives columns other than status are immutable';
  END IF;
END$$

DELIMITER ;
