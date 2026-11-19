-- 0381_ai_budget_pools_periods — the AI spending pools and the monthly counters (plan 62, 62-05, B08).
--
-- ## What this migration is for
--
-- The in-app AI spends real money. Before any model call one transaction takes a hold on the
-- member, the workspace and the pool with conditional updates (`... WHERE settled + reserved +
-- :hold <= cap`); after the call the real cost is settled and the rest released (62-06). These
-- three tables hold those counters. Nothing writes them yet: no data is inserted here and no code
-- path reaches them until the budget service (62-06) is wired.
--
-- - `ai_budget_pools` (PLATFORM, non-tenant): one row per pool per month. `pool` is 'customers',
--   'testing', 'reserve' or 'packs' (plan 62 §5: 60 / 25 / 15 USD, packs 0 until paid packs
--   exist). Money in integer micro-USD: `cap_micro_usd`, `settled_micro_usd` (the real cost of
--   every call, success or not, so the cap is true), `reserved_micro_usd` (open holds).
--   `paused_at` / `paused_reason` stop all spending from the pool (100 %, over-settlement).
-- - `ai_workspace_periods` (TENANT): one row per workspace per month, in credits (1 credit =
--   0.001 USD). `allowance_credits` is the plan allowance resolved for that month; the workspace
--   is debited only for successful work that was not undone (`settled_credits`), while open holds
--   sit in `reserved_credits`.
-- - `ai_member_periods` (TENANT): one row per member per month: the member's share
--   (`cap_credits`) and counters, plus the two per-day limits of plan 62 §5 (free support 20 a
--   day, refunds 5 a day) as a day and a count, reset by the service when the day changes.
--
-- `period_start` is the first day of the month (UTC). Every counter is unsigned with a literal 0
-- default, so a conditional update can never take it below zero unnoticed.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- New tables only, one CREATE per statement (the migrator resumes an interrupted file at its first
-- unapplied statement and treats "already exists" on that statement as applied). Plain columns,
-- DATE / DATETIME(3), ENUM with literal values, literal defaults, no CHECK, no generated column, no
-- functional or partial index, no trigger, no foreign key (the 0257 convention).

CREATE TABLE ai_budget_pools (
  id                 CHAR(36)        NOT NULL,
  pool               ENUM('customers', 'testing', 'reserve', 'packs') NOT NULL,
  period_start       DATE            NOT NULL,
  cap_micro_usd      BIGINT UNSIGNED NOT NULL,
  settled_micro_usd  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  reserved_micro_usd BIGINT UNSIGNED NOT NULL DEFAULT 0,
  paused_at          DATETIME(3)     NULL,
  paused_reason      VARCHAR(32)     CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at         DATETIME(3)     NOT NULL,
  updated_at         DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_budget_pools_pool_period (pool, period_start)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ai_workspace_periods (
  id                CHAR(36)     NOT NULL,
  organization_id   CHAR(36)     NOT NULL,
  period_start      DATE         NOT NULL,
  allowance_credits INT UNSIGNED NOT NULL,
  settled_credits   INT UNSIGNED NOT NULL DEFAULT 0,
  reserved_credits  INT UNSIGNED NOT NULL DEFAULT 0,
  paused_at         DATETIME(3)  NULL,
  created_at        DATETIME(3)  NOT NULL,
  updated_at        DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_workspace_periods_org_id (organization_id, id),
  UNIQUE KEY uq_ai_workspace_periods_org_period (organization_id, period_start)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ai_member_periods (
  id                 CHAR(36)          NOT NULL,
  organization_id    CHAR(36)          NOT NULL,
  membership_id      CHAR(36)          NOT NULL,
  period_start       DATE              NOT NULL,
  cap_credits        INT UNSIGNED      NOT NULL,
  settled_credits    INT UNSIGNED      NOT NULL DEFAULT 0,
  reserved_credits   INT UNSIGNED      NOT NULL DEFAULT 0,
  free_support_day   DATE              NULL,
  free_support_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  refunds_day        DATE              NULL,
  refunds_count      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at         DATETIME(3)       NOT NULL,
  updated_at         DATETIME(3)       NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_member_periods_org_id (organization_id, id),
  UNIQUE KEY uq_ai_member_periods_member_period (organization_id, membership_id, period_start)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
