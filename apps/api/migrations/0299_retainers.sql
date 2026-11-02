-- 0299_retainers — 52-06 retainers (R17 slice d).
--
-- ## What this migration is for
--
-- A retainer is "Acme — Social media, 40 h/month, rollover up to 10 h": an allowance per period
-- for one client organization, counted against the time logged on the projects it covers.
--
-- - `retainers` (TENANT, new) — the agreement. `period` ('monthly' | 'quarterly'), `rollover`
--   ('none' | 'cap' | 'unlimited'), `billing_timing` ('advance' | 'arrears') and `state`
--   ('active' | 'paused' | 'ended') are closed lists checked in the application (VARCHAR, not
--   ENUM). Hours and/or an amount per period; the amount is in the organization's base currency.
--   `rate_card_id` is reserved for 52-09 invoicing and is not written yet. Bound within the tenant
--   to `client_organizations (organization_id, id)`.
-- - `retainer_projects` (TENANT, new) — the projects a retainer covers. One retainer per project at
--   a time is checked in the service (a 409), not by a key: an ended retainer keeps its rows.
-- - `retainer_periods` (TENANT, new) — one row per period. `UNIQUE (organization_id, retainer_id,
--   period_start)` is the period roll's idempotency key: a second pass that tries to open the same
--   period hits the key and skips. `used_minutes_cache` / `overage_minutes_cache` are derived (one
--   SUM over `work_item_time_logs`): the API reads the live SUM for an open period and the cache for
--   a closed one, which is frozen at close. `invoice_id` is reserved for 52-09.
-- - `work_item_time_logs.retainer_period_id` — RESERVED and never written by this slice:
--   attribution is computed at read time by the SUM above. Stamping rows would hit the 0265
--   locked-row trigger and the time-log writers owned elsewhere.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATE / DATETIME(3), composite tenant keys, no generated columns, no CHECK, no JSON
-- column, utf8mb4_unicode_ci — the 0283 / 0291 conventions.
--
-- ## Grants (scripts/db/users.sql, 0299 block)
--
-- `tmanage_app`: SELECT, INSERT, UPDATE on `retainers` and `retainer_periods`; SELECT, INSERT,
-- DELETE on `retainer_projects` (replace-all). `tmanage_worker`: SELECT on `retainers`,
-- `retainer_projects`; SELECT, INSERT, UPDATE on `retainer_periods` (the roll). Nobody deletes a
-- retainer or a period: they are history.

CREATE TABLE retainers (
  id                       CHAR(36)      NOT NULL,
  organization_id          CHAR(36)      NOT NULL,
  client_organization_id   CHAR(36)      NOT NULL,
  name                     VARCHAR(120)  NOT NULL,
  -- 'monthly' | 'quarterly' (checked in the application).
  period                   VARCHAR(12)   NOT NULL DEFAULT 'monthly',
  hours_per_period         INT           NULL,
  amount_per_period_minor  BIGINT        NULL,
  currency                 CHAR(3)       NULL,
  -- 'none' | 'cap' | 'unlimited' (checked in the application).
  rollover                 VARCHAR(12)   NOT NULL DEFAULT 'none',
  rollover_cap_minutes     INT           NULL,
  -- 'advance' | 'arrears' (checked in the application).
  billing_timing           VARCHAR(12)   NOT NULL DEFAULT 'advance',
  starts_on                DATE          NOT NULL,
  ends_on                  DATE          NULL,
  -- 'active' | 'paused' | 'ended' (checked in the application).
  state                    VARCHAR(12)   NOT NULL DEFAULT 'active',
  client_visible           TINYINT(1)    NOT NULL DEFAULT 1,
  -- Reserved for 52-09.
  rate_card_id             CHAR(36)      NULL,
  created_by               CHAR(36)      NOT NULL,
  created_at               DATETIME(3)   NOT NULL,
  updated_at               DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_retainers_org_id (organization_id, id),
  KEY ix_retainers_client_state (organization_id, client_organization_id, state),
  CONSTRAINT fk_retainers_client_tenant
    FOREIGN KEY (organization_id, client_organization_id)
    REFERENCES client_organizations (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE retainer_projects (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  retainer_id      CHAR(36)     NOT NULL,
  project_id       CHAR(36)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_retainer_projects_org_id (organization_id, id),
  UNIQUE KEY uq_retainer_projects_identity (organization_id, retainer_id, project_id),
  -- The double-cover check reads by project.
  KEY ix_retainer_projects_project (organization_id, project_id),
  CONSTRAINT fk_retainer_projects_retainer_tenant
    FOREIGN KEY (organization_id, retainer_id) REFERENCES retainers (organization_id, id),
  CONSTRAINT fk_retainer_projects_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE retainer_periods (
  id                     CHAR(36)     NOT NULL,
  organization_id        CHAR(36)     NOT NULL,
  retainer_id            CHAR(36)     NOT NULL,
  period_start           DATE         NOT NULL,
  period_end             DATE         NOT NULL,
  allowance_minutes      INT          NOT NULL DEFAULT 0,
  rollover_in_minutes    INT          NOT NULL DEFAULT 0,
  used_minutes_cache     INT          NOT NULL DEFAULT 0,
  overage_minutes_cache  INT          NOT NULL DEFAULT 0,
  -- 'open' | 'closed' (checked in the application).
  state                  VARCHAR(12)  NOT NULL DEFAULT 'open',
  -- Reserved for 52-09.
  invoice_id             CHAR(36)     NULL,
  closed_at              DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_retainer_periods_org_id (organization_id, id),
  UNIQUE KEY uq_retainer_periods_start (organization_id, retainer_id, period_start),
  -- The roll's cross-tenant scan: open periods by end day.
  KEY ix_retainer_periods_open (state, period_end),
  CONSTRAINT fk_retainer_periods_retainer_tenant
    FOREIGN KEY (organization_id, retainer_id) REFERENCES retainers (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE work_item_time_logs
  ADD COLUMN retainer_period_id CHAR(36) NULL,
  ADD KEY ix_witl_retainer (organization_id, retainer_period_id);

-- organization_id is immutable on all three (ADR-0001 layer 1), as on every tenant table.
DELIMITER $$

CREATE TRIGGER trg_retainers_org_immutable
BEFORE UPDATE ON retainers FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'retainers.organization_id is immutable';
  END IF;
END$$

CREATE TRIGGER trg_retainer_projects_org_immutable
BEFORE UPDATE ON retainer_projects FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'retainer_projects.organization_id is immutable';
  END IF;
END$$

CREATE TRIGGER trg_retainer_periods_org_immutable
BEFORE UPDATE ON retainer_periods FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'retainer_periods.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
