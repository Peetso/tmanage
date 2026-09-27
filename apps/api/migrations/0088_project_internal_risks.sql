-- 0088_project_internal_risks — FEAT: Internal project risk register (PROJ / module 8, x209).
--
-- Migration number: the brief reserves 0088 for x209. The migrator applies files in ascending
-- numeric order and a gap is not an error (it rejects only a NEW file numbered *below* an applied
-- one), so 0088 on top of the base's highest migration is correct. If integration renumbers the
-- reservation, the integrator renumbers this file with it; nothing here depends on the literal 0088
-- beyond the filename.
--
-- Governing sources: 38-MODULE-MAP §Projects & portfolio, 23-ERD-AND-STATE-MACHINES §2
-- (`PROJECT ||--o{ …` project-owned records), 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## Why this is NOT `project_risks` (0049, x140)
--
-- x140 built `project_risks` in the *clients* module: an internal write surface plus a client
-- projection (`client_summary`, `published`) so a studio can publish a risk to a client's portal.
-- Its shape is a single `severity` flag and a client-facing summary. This table is a different
-- thing: an **internal-only** risk register keyed on a formal likelihood×impact matrix, with a
-- `mitigation` plan and a lifecycle `status`. It is never projected to a client — there is no
-- `client_summary`, no `published`, and it is deliberately absent from every `client_projection.read`
-- path (the portal service does not touch this table). Because the name `project_risks` is already
-- taken by 0049, this internal register is `project_internal_risks`.
--
-- ## Project-owned, and tenant-scoped like every sibling
--
-- `project_internal_risks.project_id` is `NOT NULL`: a risk belongs to a project, the way an
-- objective (0040), an update (0041) and a milestone (0048) do. The composite foreign key
-- `fk_project_internal_risks_project_tenant` binds `(organization_id, project_id)` to `projects`, so
-- a risk can only ever name a project of its own tenant — a cross-tenant project id does not exist as
-- a pair even when both ids exist individually.
--
-- ## What may move
--
-- A risk is authored and then worked: its `title`, `likelihood`, `impact`, `mitigation` and `status`
-- are all editable (the register is a living document). Its identity — `id`, `organization_id`,
-- `project_id`, `created_by`, `created_at` — is not. The `BEFORE UPDATE` trigger pins the identity
-- columns at the engine, so a direct SQL session cannot re-point a risk at another project or tenant
-- (which would move it into another studio's register silently), matching the guarantee
-- `project_updates` and `project_milestones` make. `severity` is NOT a column: it is computed from
-- `likelihood` × `impact` in the service, so the matrix is the single source of truth and cannot
-- drift from a stored flag.

CREATE TABLE project_internal_risks (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- NOT NULL. A risk belongs to a project; see the note above.
  project_id         CHAR(36)     NOT NULL,
  -- `documents.title` / `project_updates.title` are VARCHAR(300); a risk handle is the same kind of
  -- short label.
  title              VARCHAR(300) NOT NULL,
  -- The two axes of the risk matrix. Each is a fixed three-point scale; severity is computed from
  -- their product in the service, never stored.
  likelihood         ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  impact             ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  -- The mitigation plan. Nullable — a risk may be logged before its mitigation is written.
  mitigation         TEXT         NULL,
  -- Where the risk sits in its lifecycle.
  status             ENUM('open','mitigating','mitigated','closed') NOT NULL DEFAULT 'open',
  -- The person who logged the risk — the service passes `context.userId`.
  created_by         CHAR(36)     NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_project_internal_risks_org_id (organization_id, id),
  -- The index the register is listed by: this tenant's risks for this project, in creation order.
  -- Leads with `organization_id` per 07-DATA-MODEL §9.
  KEY ix_project_internal_risks_org_project (organization_id, project_id, created_at),
  CONSTRAINT fk_project_internal_risks_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_project_internal_risks_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A risk's identity is pinned at the engine; its substance (title, likelihood, impact, mitigation,
-- status) may move. The trigger refuses an UPDATE that changes any identity column — a direct SQL
-- session bypasses the application layers, so the guarantee that a risk cannot be re-pointed at
-- another project or tenant must hold at the engine too.
DELIMITER $$

CREATE TRIGGER trg_project_internal_risks_pin_identity
BEFORE UPDATE ON project_internal_risks FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id)
     OR NOT (NEW.organization_id <=> OLD.organization_id)
     OR NOT (NEW.project_id <=> OLD.project_id)
     OR NOT (NEW.created_by <=> OLD.created_by)
     OR NOT (NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_internal_risks identity columns are immutable';
  END IF;
END$$

DELIMITER ;
