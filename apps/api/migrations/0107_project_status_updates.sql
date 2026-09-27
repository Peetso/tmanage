-- 0107_project_status_updates — FEAT: Internal project status updates (PROJ / module 8, x235).
--
-- Migration number: the pass-23 queue reserves 0107 for x235. The migrator applies files in
-- ascending numeric order and a gap is not an error (it rejects only a NEW file numbered *below* an
-- applied one), so 0107 on top of the base's highest migration is correct. If integration renumbers
-- the reservation, the integrator renumbers this file with it; nothing here depends on the literal
-- 0107 beyond the filename.
--
-- Governing sources: 38-MODULE-MAP §Projects & portfolio, 23-ERD-AND-STATE-MACHINES §2
-- (`PROJECT ||--o{ …` project-owned records), 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## Why this is NOT `project_updates` (0041, x125) and NOT the portal client updates
--
-- x125 built `project_updates` in the *clients* module: a client-facing update a studio publishes to
-- a client's portal. This table is a different thing: an **internal** project status changelog — the
-- studio's own running log of where a project stands (`on_track` / `at_risk` / `off_track`) with a
-- free-text `body`. It is never projected to a client — there is no `published`, no `client_summary`,
-- and it is deliberately absent from every `client_projection.read` path (the portal service does not
-- touch this table). Because the name `project_updates` is already taken by 0041, this internal
-- status log is `project_status_updates`.
--
-- ## Project-owned, tenant-scoped, and append-only
--
-- `project_status_updates.project_id` is `NOT NULL`: an update belongs to a project, the way an
-- objective (0040), a milestone (0048) and an internal risk (0088) do. The composite foreign key
-- `fk_project_status_updates_project_tenant` binds `(organization_id, project_id)` to `projects`, so
-- an update can only ever name a project of its own tenant — a cross-tenant project id does not exist
-- as a pair even when both ids exist individually.
--
-- A status update is a point-in-time post: once written it is the durable record of what was said and
-- when, so the whole row is immutable. The `BEFORE UPDATE` trigger refuses every UPDATE at the
-- engine, so a direct SQL session cannot rewrite history; the runtime credential is granted INSERT
-- only (see scripts/db/users.sql). There is no edit or delete path in this slice.

CREATE TABLE project_status_updates (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- NOT NULL. An update belongs to a project; see the note above.
  project_id         CHAR(36)     NOT NULL,
  -- The status band the studio is recording for the project at this point in time. A fixed
  -- three-point scale; there is no free-form band.
  status_band        ENUM('on_track','at_risk','off_track') NOT NULL DEFAULT 'on_track',
  -- The narrative of the update. `TEXT`; bounded at the application layer (a form field, not a
  -- document). Required — an update with no body is not a status update.
  body               TEXT         NOT NULL,
  -- The person who posted the update — the service passes `context.userId`.
  posted_by          CHAR(36)     NOT NULL,
  posted_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_project_status_updates_org_id (organization_id, id),
  -- The index the log is listed by: this tenant's updates for this project, newest first. Leads with
  -- `organization_id` per 07-DATA-MODEL §9. The keyset page orders by `(posted_at, id)` descending;
  -- this covers the range scan.
  KEY ix_project_status_updates_org_project (organization_id, project_id, posted_at, id),
  CONSTRAINT fk_project_status_updates_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_project_status_updates_posted_by
    FOREIGN KEY (posted_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A status update is immutable — it is a durable, point-in-time record. The trigger refuses every
-- UPDATE: a direct SQL session bypasses the application layers, so the append-only guarantee (a post
-- cannot be silently rewritten to say something else, or re-pointed at another project or tenant)
-- must hold at the engine too. The runtime credential is granted INSERT only, so this is defence in
-- depth for any other session.
DELIMITER $$

CREATE TRIGGER trg_project_status_updates_immutable
BEFORE UPDATE ON project_status_updates FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'project_status_updates rows are immutable';
END$$

DELIMITER ;
