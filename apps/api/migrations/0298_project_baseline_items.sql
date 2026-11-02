-- 0298_project_baseline_items — 53-05 baselines on the timeline and schedule variance (R17-c).
--
-- Governing sources: 53-FEATURE-GAPS-PLANNING-COLLAB.md "53-05" and §8.1, 0162 (the milestone-only
-- `project_baselines` JSON snapshot this extends), 0283 (the working calendar the variance counts
-- in), 25-AUTHORIZATION-AND-TENANT-ISOLATION §5-7 (composite tenant keys), ADR-0001.
--
-- ## What changes
--
-- 0162 froze only the milestone plan. 53-05 freezes every live work item's start and due date too,
-- so the Gantt can draw ghost bars and the variance view can say how many *working* days each item
-- slipped. Three columns on `project_baselines` and one new child table:
--
-- * `kind` — 'milestones' (the 0162 shape, the default for every existing row) or 'full' (milestones
--   plus item rows). Checked in the application.
-- * `is_current` — the one baseline the timeline overlays. At most one per project, kept by the
--   service in one UPDATE statement inside a transaction. It is the **only** column that may change
--   after insert: `trg_project_baselines_only_current` refuses any other change at the engine, so the
--   UPDATE grant this migration needs cannot be used to rewrite a frozen plan.
-- * `note` — an internal note on why the baseline was taken. Never leaves the internal routes.
--
-- `project_baseline_items` holds one row per work item frozen into a 'full' baseline: civil start
-- and due dates (in the org calendar's zone at snapshot time), the working-day duration, and the
-- item's `version` at that moment. Rows are INSERT-only for the app (no UPDATE grant) and are removed
-- with their baseline (ON DELETE CASCADE). There is deliberately **no** foreign key to `work_items`:
-- an item purged later must not block the purge, and its frozen row is exactly what the variance view
-- reports as 'removed'.
--
-- MariaDB-safe like 0283: no generated columns, no functional or descending index parts, no CHECK
-- that MariaDB would parse differently; every trigger uses `<=>` so a NULL compares as a value.

ALTER TABLE project_baselines
  ADD COLUMN kind       VARCHAR(12)  NOT NULL DEFAULT 'milestones' AFTER snapshot,
  ADD COLUMN is_current TINYINT(1)   NOT NULL DEFAULT 0            AFTER kind,
  ADD COLUMN note       VARCHAR(500) NULL                          AFTER is_current,
  ADD KEY ix_project_baselines_org_project_current (organization_id, project_id, is_current);

DROP TRIGGER IF EXISTS trg_project_baselines_only_current;

DELIMITER $$

CREATE TRIGGER trg_project_baselines_only_current
BEFORE UPDATE ON project_baselines FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id)
     OR NOT (NEW.organization_id <=> OLD.organization_id)
     OR NOT (NEW.project_id <=> OLD.project_id)
     OR NOT (NEW.label <=> OLD.label)
     OR NOT (NEW.snapshot <=> OLD.snapshot)
     OR NOT (NEW.kind <=> OLD.kind)
     OR NOT (NEW.note <=> OLD.note)
     OR NOT (NEW.created_by <=> OLD.created_by)
     OR NOT (NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_baselines are frozen: only is_current may change';
  END IF;
END$$

DELIMITER ;

CREATE TABLE project_baseline_items (
  id                    CHAR(36)          NOT NULL,
  organization_id       CHAR(36)          NOT NULL,
  baseline_id           CHAR(36)          NOT NULL,
  -- No foreign key to work_items: see the note above.
  work_item_id          CHAR(36)          NOT NULL,
  -- Civil dates in the org calendar's zone at snapshot time; NULL when the item had none.
  start_at              DATE              NULL,
  due_at                DATE              NULL,
  -- Working days from start to due, inclusive of a working due day; NULL without both dates.
  duration_working_days SMALLINT          NULL,
  -- The work item's `version` at snapshot time.
  item_version          INT UNSIGNED      NULL,
  -- Reserved for the milestone the item rolled up to; NULL until a work-item milestone link exists.
  milestone_id          CHAR(36)          NULL,
  created_at            DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_project_baseline_items_org_id (organization_id, id),
  -- One frozen row per item per baseline; also the overlay/variance read path.
  UNIQUE KEY uq_project_baseline_items_baseline_item (organization_id, baseline_id, work_item_id),
  CONSTRAINT fk_project_baseline_items_baseline_tenant
    FOREIGN KEY (organization_id, baseline_id) REFERENCES project_baselines (organization_id, id)
    ON DELETE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_project_baseline_items_org_immutable
BEFORE UPDATE ON project_baseline_items FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_baseline_items.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
