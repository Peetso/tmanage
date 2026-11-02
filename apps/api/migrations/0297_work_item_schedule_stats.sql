-- 0297_work_item_schedule_stats — 53-06 critical path, float and schedule health (R17 slice b).
--
-- ## What this migration is for
--
-- 53-04 gave work items typed dependencies (FS / SS / FF / SF with a working-day lag) and 53-02 a
-- working calendar. 53-06 runs the critical path method over them per project and keeps the answer,
-- so the timeline, the project health card and the critical-path read do not each recompute it.
-- One tenant table:
--
-- - `work_item_schedule_stats` (TENANT, new) — one row per scheduled work item of a project: its
--   early / late start and finish (company-calendar civil dates), total float in working days and
--   whether it is critical (float 0). A recompute replaces all of a project's rows in one
--   transaction under one `batch_id` (DELETE, then INSERT), so readers never see two batches mixed.
--   `computed_at` is when that batch ran; a read whose rows are older than the project's newest
--   `work_items.updated_at` recomputes first.
--
-- No foreign key to `work_items`: a recompute replaces the project's rows, and a deleted item simply
-- has no row in the next batch. The project is bound within the tenant by the composite foreign key
-- `(organization_id, project_id) -> projects (organization_id, id)`.
--
-- The table has no `id`: its primary key `(organization_id, work_item_id)` leads with the tenant
-- column (the convention for a tenant table without an id). `(organization_id, project_id,
-- is_critical)` serves the per-project reads and the health card's critical count.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATE / SMALLINT / TINYINT(1) / DATETIME(3), composite tenant keys, no generated
-- columns, no CHECK, no JSON, no functional indexes, utf8mb4_unicode_ci — as 0283.
--
-- ## Grants (scripts/db/users.sql, 0297 block)
--
-- `tmanage_app`: SELECT, INSERT, UPDATE, DELETE. `tmanage_worker`: nothing (the recompute runs in the
-- API process, debounced after a schedule change).

CREATE TABLE work_item_schedule_stats (
  organization_id   CHAR(36)     NOT NULL,
  work_item_id      CHAR(36)     NOT NULL,
  project_id        CHAR(36)     NOT NULL,
  early_start       DATE         NULL,
  early_finish      DATE         NULL,
  late_start        DATE         NULL,
  late_finish       DATE         NULL,
  -- Working days; NULL when the item could not be scheduled.
  total_float_days  SMALLINT     NULL,
  is_critical       TINYINT(1)   NOT NULL DEFAULT 0,
  batch_id          CHAR(36)     NOT NULL,
  computed_at       DATETIME(3)  NOT NULL,
  PRIMARY KEY (organization_id, work_item_id),
  KEY ix_work_item_schedule_stats_project (organization_id, project_id, is_critical),
  CONSTRAINT fk_work_item_schedule_stats_project
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- organization_id is immutable (ADR-0001 layer 1), as on every tenant table.
DELIMITER $$

CREATE TRIGGER trg_wiss_org_immutable
BEFORE UPDATE ON work_item_schedule_stats FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_schedule_stats.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
