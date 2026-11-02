-- 0291_budget_burn — 52-05 budgets and burn (R16 slice b).
--
-- ## What this migration is for
--
-- `project_budgets` (0160) was a number with no alerts. This adds what a burn needs:
--
-- - Columns on `project_budgets`: `budget_type` (`hours` | `money` | `both`, checked in the
--   application), `include_expenses` (52-07 expenses count toward money burn), `client_visible`
--   (the portal projection is served only when 1), `alert_thresholds` (one to four whole percents,
--   ascending, comma-separated), `last_alert_bp` (the highest threshold already alerted, in basis
--   points — the hysteresis memory), and the derived caches `used_minutes_cache`,
--   `used_amount_cache_minor`, `cache_refreshed_at`. The caches are recomputed by one indexed SUM
--   over `work_item_time_logs` (`ix_witl_project_day`) on every budget save and by the 15-minute
--   worker sweep, which also reconciles any drift; they are never written from user input.
-- - `project_budget_phases` (TENANT, new) — an optional split of the budget by phase. `phase_id`
--   names a `project_phases` definition row or is NULL for a free-standing line; the service
--   resolves it tenant-scoped. Replace-all on save (<= 20 lines).
-- - `budget_alert_events` (TENANT, new) — one row per alert the sweep raised: the threshold, the
--   usage it saw and who was told (`notified_to`, a JSON array of user ids as TEXT — no JSON column
--   type, MariaDB-safe). History: no UPDATE or DELETE grant.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATETIME(3), composite tenant keys, no generated columns, no CHECK, no JSON
-- column, utf8mb4_unicode_ci — the 0283/0287 conventions.
--
-- ## Grants (scripts/db/users.sql, 0291 block)
--
-- `tmanage_app`: SELECT, INSERT, UPDATE, DELETE on `project_budget_phases`; SELECT, INSERT on
-- `budget_alert_events`. `tmanage_worker`: SELECT, UPDATE on `project_budgets` (the caches and
-- `last_alert_bp`); SELECT, INSERT on `budget_alert_events`. The worker already reads
-- `work_item_time_logs` (52-01).

ALTER TABLE project_budgets
  ADD COLUMN budget_type VARCHAR(8) NOT NULL DEFAULT 'hours',
  ADD COLUMN include_expenses TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN client_visible TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN alert_thresholds VARCHAR(32) NOT NULL DEFAULT '70,85,95,100',
  ADD COLUMN last_alert_bp INT NOT NULL DEFAULT 0,
  ADD COLUMN used_minutes_cache INT NOT NULL DEFAULT 0,
  ADD COLUMN used_amount_cache_minor BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN cache_refreshed_at DATETIME(3) NULL;

-- Rows saved before 0291 named an amount and maybe hours; keep their meaning.
UPDATE project_budgets
   SET budget_type = CASE
         WHEN budget_minutes IS NOT NULL AND budget_amount_minor IS NOT NULL THEN 'both'
         WHEN budget_amount_minor IS NOT NULL THEN 'money'
         ELSE 'hours'
       END,
       -- Explicitly kept, so the backfill does not look like a save.
       updated_at = updated_at;

CREATE TABLE project_budget_phases (
  id                  CHAR(36)      NOT NULL,
  organization_id     CHAR(36)      NOT NULL,
  project_id          CHAR(36)      NOT NULL,
  -- A `project_phases` definition row, or NULL for a free-standing budget line.
  phase_id            CHAR(36)      NULL,
  name                VARCHAR(120)  NOT NULL,
  budget_minutes      INT           NULL,
  budget_amount_minor BIGINT        NULL,
  position            INT           NOT NULL DEFAULT 0,
  created_at          DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_project_budget_phases_org_id (organization_id, id),
  KEY ix_project_budget_phases_project (organization_id, project_id, position),
  CONSTRAINT fk_project_budget_phases_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE budget_alert_events (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  project_id       CHAR(36)     NOT NULL,
  threshold_bp     INT          NOT NULL,
  used_bp          INT          NOT NULL,
  -- JSON array of the user ids told, as TEXT (MariaDB-safe).
  notified_to      TEXT         NOT NULL,
  created_at       DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_budget_alert_events_org_id (organization_id, id),
  UNIQUE KEY uq_budget_alert_events_dedupe (organization_id, project_id, threshold_bp, created_at),
  CONSTRAINT fk_budget_alert_events_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- organization_id is immutable on both (ADR-0001 layer 1), as on every tenant table.
DELIMITER $$

CREATE TRIGGER trg_project_budget_phases_org_immutable
BEFORE UPDATE ON project_budget_phases FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_budget_phases.organization_id is immutable';
  END IF;
END$$

CREATE TRIGGER trg_budget_alert_events_org_immutable
BEFORE UPDATE ON budget_alert_events FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'budget_alert_events.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
