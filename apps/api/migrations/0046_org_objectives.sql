-- 0046_org_objectives — an organization's objectives / OKRs (PROJ / module 8, x136).
--
-- Migration number: NEXT-SCOPES-12 reserves 0046 for x136. The highest migration after pass 19 is
-- 0041 (x125 project_updates); pass 20 reserves 0042…0059 in id order, and this slice is 0046. The
-- migrator applies files in ascending numeric order and a gap is not an error (it rejects only a NEW
-- file numbered *below* an applied one), so 0046 is correct on this base. If integration renumbers a
-- sibling reservation the integrator renumbers this file with it; nothing here depends on the literal
-- 0046 beyond the filename.
--
-- Governing sources: 38-MODULE-MAP §Projects & portfolio ("objectives, portfolio roll-up"),
-- 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §Projects (org objectives/OKR screens), NEXT-SCOPES-11
-- (org OKRs deferred → x136), 07-DATA-MODEL §9 (index prefixes lead with `organization_id`),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- x124 (0040) added `project_objectives` — an objective that belongs to one project. This is the
-- org-level counterpart NEXT-SCOPES-11 deferred: an objective the whole organization is aiming at,
-- with no project. A name, an optional description and target, a short status, who created it and
-- when. It is deliberately *not* key results, metrics, or an objective→project cascade — those are
-- deferred (NEXT-SCOPES-13). This table carries only what an org objective *is*.
--
-- ## Org-owned, and tenant-scoped like every sibling
--
-- Unlike `project_objectives`, there is no `project_id`: an org objective belongs to the tenant, not
-- to a project, so authorization is org-scoped (see `OrgObjectivesService`) rather than
-- relation-gated on a project. `organization_id` is `NOT NULL` and the `(organization_id, id)`
-- unique key every tenant table carries is present, so the tenant guard and a future child (a key
-- result, an objective→project edge) can reference this row without a cross-tenant path.
--
-- ## Status may move; nothing else may
--
-- Like `project_objectives`, an objective has a lifecycle: `open → met` or `open → missed`. So the
-- runtime credential holds UPDATE (see `users.sql`), and the `BEFORE UPDATE` trigger is a
-- *column-pinning* one from birth — `status` may change, and every other column is pinned at the
-- engine. A direct SQL session bypasses ADR-0001's application layers, so the pin lives here too. The
-- transition itself is guarded in the service (an illegal one is a 409 with no write); the trigger
-- only guarantees no *other* column is rewritten under any path.

CREATE TABLE org_objectives (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- `organizations.name` / `projects.name` are short handles; an objective's name is the same kind.
  name               VARCHAR(300) NOT NULL,
  -- Optional prose describing the objective. TEXT and nullable — an objective may be a one-liner.
  description        TEXT         NULL,
  -- Optional target the objective aims at, as a short handle a person types (e.g. "95% on-time",
  -- "ship by Q3"). Not a number: a target is expressed in the organization's own terms this slice.
  target             VARCHAR(300) NULL,
  -- Where the objective stands. `open` at creation; the lifecycle transitions to `met` or `missed`.
  status             ENUM('open','met','missed') NOT NULL DEFAULT 'open',
  -- The person who created the objective — the service passes `context.userId`.
  created_by         CHAR(36)     NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_org_objectives_org_id (organization_id, id),
  -- The index an organization's objectives are listed by: this tenant's objectives in creation order
  -- (the list reads `created_at ASC`). Leads with `organization_id` per 07-DATA-MODEL §9.
  KEY ix_org_objectives_org_created (organization_id, created_at),
  CONSTRAINT fk_org_objectives_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_org_objectives_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An objective's substance is pinned at the engine; only `status` may move. A direct SQL session
-- bypasses the application layers, so the guarantee that "who set the objective and its wording do
-- not change under a status transition" must hold at the engine too.
DELIMITER $$

CREATE TRIGGER trg_org_objectives_pin_columns
BEFORE UPDATE ON org_objectives FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id)
     OR NOT (NEW.organization_id <=> OLD.organization_id)
     OR NOT (NEW.name <=> OLD.name)
     OR NOT (NEW.description <=> OLD.description)
     OR NOT (NEW.target <=> OLD.target)
     OR NOT (NEW.created_by <=> OLD.created_by)
     OR NOT (NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'org_objectives columns other than status are immutable';
  END IF;
END$$

DELIMITER ;
