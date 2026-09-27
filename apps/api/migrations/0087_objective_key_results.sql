-- 0087_objective_key_results — a project objective's key results (PROJ / module 8, x207).
--
-- Migration number: NEXT-SCOPES-14 reserves 0081–0093 for pass 22 in id order and assigns **0087** to
-- x207. The migrator applies files in ascending numeric order and a gap is not an error (it rejects
-- only a NEW file numbered *below* an applied one), so 0087 on top of this branch's base is correct.
-- If integration renumbers a sibling's reservation, the integrator renumbers this file with it;
-- nothing here depends on the literal 0087 beyond the filename.
--
-- Governing sources: 38-MODULE-MAP §Projects & portfolio ("objectives, key results"),
-- 23-ERD-AND-STATE-MACHINES §2 (`PROJECT_OBJECTIVE ||--o{ …` objective-owned children), 07-DATA-MODEL
-- §9 (index prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite
-- tenant keys).
--
-- ## What this migration is for
--
-- x124 gave a project its objectives; the objective view advertises measurable key results but there
-- was no table to hold them. This is an objective's key results at rest: a title, a numeric target and
-- current value, the unit they are expressed in, who created it and when, and when it last changed.
-- Progress (%) is computed from `current_value / target_value` on read (bounded, div-by-zero safe) —
-- it is not stored, so it can never drift from the values it is derived from.
--
-- ## Objective-owned, and tenant-scoped like every sibling
--
-- `objective_key_results.objective_id` is `NOT NULL`: a key result belongs to a project objective, the
-- way an `objective_work_links` edge does. Authorization is relation-gated on the objective's project
-- (see `KeyResultsService`), so a key result with no objective would have no relation to check. The
-- composite foreign key `fk_objective_key_results_objective_tenant` binds `(organization_id,
-- objective_id)` to `project_objectives`, so a key result can only ever name an objective of its own
-- tenant — a cross-tenant objective id does not exist as a pair even when both ids exist individually.
--
-- ## The value columns may move; the identity may not
--
-- A key result has an editable body (its title, target, current and unit are all revised as work
-- progresses), so the runtime credential holds UPDATE (see `users.sql`) and the `BEFORE UPDATE` trigger
-- is a *column-pinning* one that pins only the identity/provenance columns — `id`, `organization_id`,
-- `objective_id`, `created_by` and `created_at` — while `title`, `target_value`, `current_value`,
-- `unit` and `updated_at` may change. A direct SQL session bypasses ADR-0001's application layers, so
-- the pin lives here too: the objective a key result belongs to, and who created it and when, cannot be
-- rewritten under any path.

CREATE TABLE objective_key_results (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- NOT NULL. A key result belongs to a project objective; see the note above.
  objective_id       CHAR(36)     NOT NULL,
  -- A short handle for what the key result measures (e.g. "Trial-to-paid conversion").
  title              VARCHAR(300) NOT NULL,
  -- The value the key result aims at. A signed BIGINT so the application (not the engine) owns the
  -- meaning; the service validates it is a non-negative safe integer, and progress guards target = 0.
  target_value       BIGINT       NOT NULL,
  -- Where the key result currently stands. Defaults to 0 at creation and is the column an inline
  -- progress edit moves.
  current_value      BIGINT       NOT NULL DEFAULT 0,
  -- The unit the target/current are expressed in (e.g. "%", "customers", "ms"), a short handle.
  unit               VARCHAR(64)  NOT NULL,
  -- The person who created the key result — the service passes `context.userId`.
  created_by         CHAR(36)     NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries (a patch names the row by id).
  UNIQUE KEY uq_objective_key_results_org_id (organization_id, id),
  -- The index the list reads: this tenant's key results for one objective, in creation order. Leads
  -- with `organization_id` per 07-DATA-MODEL §9.
  KEY ix_objective_key_results_org_objective (organization_id, objective_id, created_at),
  CONSTRAINT fk_objective_key_results_objective_tenant
    FOREIGN KEY (organization_id, objective_id) REFERENCES project_objectives (organization_id, id),
  CONSTRAINT fk_objective_key_results_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A key result's identity and provenance are pinned at the engine; only its body may move. The trigger
-- refuses an UPDATE that changes any identity column, the reason `project_objectives` (0040) carries a
-- column-pinning trigger — a direct SQL session bypasses the application layers, so the guarantee that
-- "which objective a key result belongs to, and who created it and when, do not change under an edit"
-- must hold at the engine too.
DELIMITER $$

CREATE TRIGGER trg_objective_key_results_pin_columns
BEFORE UPDATE ON objective_key_results FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id)
     OR NOT (NEW.organization_id <=> OLD.organization_id)
     OR NOT (NEW.objective_id <=> OLD.objective_id)
     OR NOT (NEW.created_by <=> OLD.created_by)
     OR NOT (NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'objective_key_results identity columns are immutable';
  END IF;
END$$

DELIMITER ;
