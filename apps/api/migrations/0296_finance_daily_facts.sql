-- 0296_finance_daily_facts — 52-14 profitability and utilisation reports (R17 slice a).
--
-- ## What this migration is for
--
-- The profitability, unbilled and utilisation reports read money and minutes over months for a
-- whole organization. Summing `work_item_time_logs` and `expenses` on every request does not
-- scale, so a nightly loop (and an on-demand rebuild) writes one derived row per
-- organization × day × project × member:
--
-- - `finance_daily_facts` (TENANT, new). `project_id` is '' for time or expenses with no project,
--   `membership_id` is the logger (`work_item_time_logs.logged_by`). `client_organization_id`
--   is the project's first `project_clients` row (NULL when none). Minutes: billable, non-billable,
--   write-off (non-billable entries on a project whose `billable_default` = 1) and unpriced
--   (billable entries with no rate snapshot). Money in the organization's base currency:
--   `billed_minor` = SUM(rate_snapshot_minor × minutes) / 60 over billable entries,
--   `cost_minor` = SUM(cost_snapshot_minor × minutes) / 60 over all entries (a missing snapshot
--   prices at 0 — the 52-05 burn rule), `expense_minor` = approved or invoiced expenses'
--   `amount_base_minor` plus markup when billable, `invoiced_minor` reserved for 52-09 (0 today).
--
-- A rebuild DELETEs the window and INSERTs it again from the sources, so the table never holds an
-- edited row: it can always be thrown away and recomputed. The rebuild SQL is written once in
-- `apps/api/src/modules/insights/finance-reports.repository.ts` and copied into the worker's
-- `finance-facts-store.ts`.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATE / DATETIME(3), no generated columns, no ENUM, no CHECK, no JSON, no foreign
-- keys to the derived-from tables (a fact row outlives nothing and is rebuilt nightly),
-- utf8mb4_unicode_ci — the 0283 / 0291 conventions.
--
-- ## Grants (scripts/db/users.sql, 0296 block)
--
-- `tmanage_app`: SELECT, INSERT, DELETE. `tmanage_worker`: SELECT, INSERT, DELETE, plus SELECT on
-- `expenses` (new) and the sources it already reads. Never UPDATE.

CREATE TABLE finance_daily_facts (
  id                      CHAR(36)     NOT NULL,
  organization_id         CHAR(36)     NOT NULL,
  day                     DATE         NOT NULL,
  -- '' = time or expenses with no project.
  project_id              CHAR(36)     NOT NULL DEFAULT '',
  client_organization_id  CHAR(36)     NULL,
  -- The member who logged the time or spent the expense.
  membership_id           CHAR(36)     NOT NULL DEFAULT '',
  billable_minutes        INT          NOT NULL DEFAULT 0,
  nonbillable_minutes     INT          NOT NULL DEFAULT 0,
  writeoff_minutes        INT          NOT NULL DEFAULT 0,
  unpriced_minutes        INT          NOT NULL DEFAULT 0,
  billed_minor            BIGINT       NOT NULL DEFAULT 0,
  cost_minor              BIGINT       NOT NULL DEFAULT 0,
  expense_minor           BIGINT       NOT NULL DEFAULT 0,
  -- Reserved for 52-09 invoices; 0 until then.
  invoiced_minor          BIGINT       NOT NULL DEFAULT 0,
  -- The organization's base currency at rebuild time; NULL when no finance profile exists.
  currency                CHAR(3)      NULL,
  computed_at             DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_finance_daily_facts_org_id (organization_id, id),
  UNIQUE KEY uq_finance_daily_facts_grain (organization_id, day, project_id, membership_id),
  KEY ix_finance_daily_facts_client (organization_id, day, client_organization_id),
  KEY ix_finance_daily_facts_project (organization_id, project_id, day),
  KEY ix_finance_daily_facts_computed (organization_id, computed_at),
  CONSTRAINT fk_finance_daily_facts_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- organization_id is immutable (ADR-0001 layer 1), as on every tenant table. No UPDATE is granted,
-- so this guards the migrator and any future grant.
DELIMITER $$

CREATE TRIGGER trg_finance_daily_facts_org_immutable
BEFORE UPDATE ON finance_daily_facts FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'finance_daily_facts.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
