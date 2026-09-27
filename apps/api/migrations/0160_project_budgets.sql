-- 0160_project_budgets — a project's planned budget (effort and/or amount), read back against the
-- effort already tracked on the project (PROJ / project detail, x293).
--
-- Governing sources: 22-SCREEN-INVENTORY §PRJ (the project detail screen), 38-MODULE-MAP §Projects,
-- 23-ERD-AND-STATE-MACHINES §2 (`PROJECT ||--o{ …` project-owned records), 07-DATA-MODEL §9 (index
-- prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant
-- keys).
--
-- ## Migration number
--
-- The pass-25 queue map reserves 0160 for x293. The highest migration present on this slice's base
-- (origin/master) is lower; 0116-0159 are reserved by sibling pass-19..25 branches not yet
-- integrated. The migrator applies files in ascending numeric order and a gap is not an error (it
-- rejects only a NEW file numbered below an already-applied one), so 0160 on top of the base's
-- highest is correct. If integration renumbers the reservation, the integrator renumbers this file
-- with it; nothing here depends on the literal 0160 beyond the filename.
--
-- ## One row per project, upsert; the amount is numbers only
--
-- A row is one project's budget, keyed `(organization_id, project_id)` — tenant-owned like
-- `project_objectives` (0040) and `project_internal_risks` (0088). The composite foreign key
-- `fk_project_budgets_project_tenant` binds `(organization_id, project_id)` to `projects`, so a
-- budget can only ever name a project of its own tenant — a cross-tenant project id does not exist as
-- a pair even when both ids exist individually. The repository writes
-- `INSERT ... ON DUPLICATE KEY UPDATE` against `uq_project_budgets_org_project`, so a second save
-- updates in place and a lost update is not expressible.
--
-- This is a planning number, never a payment: there is no charge, no ledger, and no rate dimension
-- here. `budget_amount_minor` is a plain planned figure in the minor unit of `currency` (numbers
-- only, per the brief).
--
-- ## Budget effort is stored in MINUTES, not hours
--
-- The API speaks in hours (`budgetHours`), but the column is `budget_minutes` — the same unit
-- `work_item_time_logs.minutes` (0103) records tracked effort in. The GET summary sums those tracked
-- minutes and compares them to this budget, so keeping both sides in integer minutes means the
-- budget-vs-tracked arithmetic (remaining, variance) is exact integer subtraction with no floating
-- decimal drift. The service converts hours ⇄ minutes at the edge (`budgetHours * 60`, validated to a
-- whole number of minutes). `INT UNSIGNED` holds any sane project budget (its ceiling is ~4.29e9
-- minutes ≈ 71 million hours); the service bounds `budgetHours` well below that.
--
-- ## At least one dimension is present
--
-- A budget names hours and/or an amount: the application refuses a save that sets neither (400, no
-- upsert). At the engine both columns are nullable so a project may budget only effort, only money,
-- or both; the "at least one" rule is the application's, the way the enum allowlists are.
--
-- ## Identity is immutable
--
-- `organization_id` and `project_id` are what a budget row IS; `created_by` and `created_at` record
-- who first set it and when. The `BEFORE UPDATE` trigger pins all four at the engine, so the upsert's
-- update path (and any direct SQL session) can only ever move the substance columns
-- (`budget_minutes`, `budget_amount_minor`, `currency`, `updated_at`) — a budget can never be
-- re-pointed at another project or tenant silently. This slice grants the app INSERT and UPDATE (the
-- upsert), no DELETE — a manager clears a budget by saving new figures, not by deleting the row.

CREATE TABLE project_budgets (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- NOT NULL. A budget belongs to a project; see the note above.
  project_id         CHAR(36)     NOT NULL,
  -- Planned effort in minutes (the unit `work_item_time_logs.minutes` uses), or NULL when the budget
  -- names only an amount. The service converts the API's `budgetHours` to minutes at the edge.
  budget_minutes     INT UNSIGNED NULL,
  -- Planned amount in the minor unit of `currency` (e.g. cents), or NULL when the budget names only
  -- effort. A plain planning figure — never charged, no ledger, no rate.
  budget_amount_minor BIGINT UNSIGNED NULL,
  -- ISO-4217 alphabetic code for `budget_amount_minor`; NULL when no amount is budgeted.
  currency           CHAR(3)      NULL,
  -- The person who first set the budget — the service passes `context.userId` on the insert path.
  created_by         CHAR(36)     NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_project_budgets_org_id (organization_id, id),
  -- One row per project per studio. This is the upsert key: the repository writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place.
  UNIQUE KEY uq_project_budgets_org_project (organization_id, project_id),
  CONSTRAINT fk_project_budgets_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_project_budgets_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A budget's identity (tenant, project, who set it, when) is immutable; only the planned figures and
-- `updated_at` move. The trigger holds identity at the engine — a direct SQL session bypasses the
-- application layers, so the guarantee that a budget cannot be re-pointed at another project or
-- tenant must hold here too. `updated_at` follows the column's `ON UPDATE`.
DELIMITER $$

CREATE TRIGGER trg_project_budgets_pin_identity
BEFORE UPDATE ON project_budgets FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id)
     OR NOT (NEW.organization_id <=> OLD.organization_id)
     OR NOT (NEW.project_id <=> OLD.project_id)
     OR NOT (NEW.created_by <=> OLD.created_by)
     OR NOT (NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_budgets identity columns are immutable';
  END IF;
END$$

DELIMITER ;
