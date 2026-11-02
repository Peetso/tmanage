-- 0287_rate_cards — 52-04 billable flag, rate cards and cost rates (R15 slice a).
--
-- ## What this migration is for
--
-- Until now no hour had a price. Three tenant tables and a handful of columns:
--
-- - `rate_cards` (TENANT, new) — a named card in one currency at one scope: `org` (the default,
--   by-role and by-person rates; `scope_id` NULL), `client` (`scope_id` = a client organization id)
--   or `project` (`scope_id` = a project id). `archived_at` retires a card without deleting the
--   history it priced. `scope` is a closed list checked in the application; `scope_id` is resolved
--   tenant-scoped by the service before insert (a 404, never a foreign-key 500).
-- - `rate_card_entries` (TENANT, new) — one hourly sell rate in minor units for a target
--   (`default` | `role` | `membership` | `service`) over an effective window `effective_from <= day <
--   effective_to` (`effective_to` NULL = open-ended). Bound within the tenant to
--   `rate_cards (organization_id, id)`. The service refuses overlapping windows for one target.
-- - `member_cost_rates` (TENANT, new) — what an hour of one member costs the company. A salary
--   proxy: its own table so the worker never holds a grant on it and no client projection can join
--   it. Read and written behind `finance.manage` only.
--
-- Columns: `projects.billable_default` (default 1) and `projects.rate_card_id` (the card that prices
-- this project; NULL = the resolver's project/client/org walk), `work_items.billable` (NULL =
-- inherit the project), and on `work_item_time_logs` the snapshots taken at log time —
-- `rate_snapshot_minor`, `cost_snapshot_minor`, `snapshot_currency` (NULL = no rate applied, never
-- 0) — plus `invoice_line_id`, which 52-09 binds when the entry is invoiced. Re-pricing only ever
-- touches rows with `invoice_line_id IS NULL AND locked_at IS NULL`.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATE / DATETIME(3), composite tenant keys, no generated columns, no CHECK, no JSON
-- defaults, utf8mb4_unicode_ci. No foreign key to `projects` / `client_organizations` /
-- `memberships` (the 0257 convention): the service resolves each tenant-scoped first.
--
-- ## Grants (scripts/db/users.sql, 0287 block)
--
-- `tmanage_app`: SELECT, INSERT, UPDATE, DELETE on all three. `tmanage_worker`: SELECT on
-- `rate_cards` and `rate_card_entries` only — never `member_cost_rates`.

CREATE TABLE rate_cards (
  id               CHAR(36)      NOT NULL,
  organization_id  CHAR(36)      NOT NULL,
  -- 'org' | 'client' | 'project' (checked in the application).
  scope            VARCHAR(16)   NOT NULL,
  -- NULL for the org card; the client organization or project id otherwise.
  scope_id         CHAR(36)      NULL,
  name             VARCHAR(120)  NOT NULL,
  currency         CHAR(3)       NOT NULL,
  archived_at      DATETIME(3)   NULL,
  created_by       CHAR(36)      NOT NULL,
  created_at       DATETIME(3)   NOT NULL,
  updated_at       DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rate_cards_org_id (organization_id, id),
  KEY ix_rate_cards_scope (organization_id, scope, scope_id, archived_at),
  CONSTRAINT fk_rate_cards_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE rate_card_entries (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  rate_card_id     CHAR(36)     NOT NULL,
  -- 'default' | 'role' | 'membership' | 'service' (checked in the application).
  target_type      VARCHAR(16)  NOT NULL,
  -- Role key, membership id or service code; NULL for 'default'.
  target_key       VARCHAR(64)  NULL,
  hourly_minor     BIGINT       NOT NULL,
  effective_from   DATE         NOT NULL,
  effective_to     DATE         NULL,
  created_at       DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rate_card_entries_org_id (organization_id, id),
  KEY ix_rate_card_entries_target (organization_id, rate_card_id, target_type, target_key, effective_from),
  CONSTRAINT fk_rate_card_entries_card_tenant
    FOREIGN KEY (organization_id, rate_card_id)
    REFERENCES rate_cards (organization_id, id)
    ON DELETE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE member_cost_rates (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  membership_id      CHAR(36)     NOT NULL,
  hourly_cost_minor  BIGINT       NOT NULL,
  currency           CHAR(3)      NOT NULL,
  effective_from     DATE         NOT NULL,
  effective_to       DATE         NULL,
  created_by         CHAR(36)     NOT NULL,
  created_at         DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_member_cost_rates_org_id (organization_id, id),
  KEY ix_member_cost_rates_member (organization_id, membership_id, effective_from),
  CONSTRAINT fk_member_cost_rates_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE projects
  ADD COLUMN billable_default TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN rate_card_id CHAR(36) NULL;

-- NULL = inherit the project's billable_default.
ALTER TABLE work_items
  ADD COLUMN billable TINYINT(1) NULL;

ALTER TABLE work_item_time_logs
  ADD COLUMN rate_snapshot_minor BIGINT NULL,
  ADD COLUMN cost_snapshot_minor BIGINT NULL,
  ADD COLUMN snapshot_currency CHAR(3) NULL,
  ADD COLUMN invoice_line_id CHAR(36) NULL;

-- organization_id is immutable on all three (ADR-0001 layer 1), as on every tenant table.
DELIMITER $$

CREATE TRIGGER trg_rate_cards_org_immutable
BEFORE UPDATE ON rate_cards FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'rate_cards.organization_id is immutable';
  END IF;
END$$

CREATE TRIGGER trg_rate_card_entries_org_immutable
BEFORE UPDATE ON rate_card_entries FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'rate_card_entries.organization_id is immutable';
  END IF;
END$$

CREATE TRIGGER trg_member_cost_rates_org_immutable
BEFORE UPDATE ON member_cost_rates FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'member_cost_rates.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
