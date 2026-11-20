-- 0390_ai_credit_pack_ledger — credit packs spent after the allowance, and the owner's pack request (plan 62, 62-07).
--
-- ## What this migration is for
--
-- Plan 62 §5: "Allowance first, then the oldest pack." A workspace's monthly AI credits are its
-- plan allowance (`ai_workspace_periods.allowance_credits`, resolved by `billing/ai-allowance.ts`)
-- plus any credit packs a platform admin granted (`ai_credit_packs`, 0383). The budget service holds
-- credits on the period row with one conditional UPDATE (`settled + reserved + hold <= cap`, 62-06).
-- To keep that one-row invariant while packs exist, pack credits are MOVED into the period only
-- when the allowance alone cannot cover a hold, oldest live pack first, exactly the amount missing:
--
-- - `ai_workspace_periods.pack_credits`: credits moved in from packs this period. The hold's cap is
--   `allowance_credits + pack_credits`, so the allowance is always spent before any pack credit.
-- - `ai_workspace_periods.pack_returned_at`: when the period's unused pack credits went back to
--   their packs (nothing rolls over in the allowance; pack credits do, until the pack expires).
-- - `ai_credit_pack_moves` (TENANT): the packs ledger. One row per move: `draw` (pack into a period)
--   or `return` (unused credits of a closed period back to the pack). Counts and ids only.
-- - `ai_credit_pack_requests` (TENANT): an owner's "Get more credits" request during testing; a
--   platform admin grants a pack against it or declines it. At most one open request per workspace:
--   `open_slot` is 1 while open and NULL after, and `uq_ai_credit_pack_requests_open` on
--   `(organization_id, open_slot)` refuses a second open row (NULLs never collide), so two
--   concurrent requests cannot both be open (DA-1: a unique constraint, not a read-then-insert).
--
-- No data is written here.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- One DDL per statement (resumable: the migrator treats "already exists" / "duplicate column" on the
-- statement its counter missed as applied, DA-8). Two nullable-or-literal-default columns on a
-- small, new table (`ai_workspace_periods` has one row per workspace per month and no write path is
-- live yet, so no long ALTER, DA-7), two new tables. ENUM with literal values, literal defaults, no
-- CHECK, no generated column, no functional or partial index, no trigger, no foreign key (the 0257
-- convention). Additive only: old code ignores the new columns and tables (DA-6).

ALTER TABLE ai_workspace_periods
  ADD COLUMN pack_credits INT UNSIGNED NOT NULL DEFAULT 0 AFTER allowance_credits;

ALTER TABLE ai_workspace_periods
  ADD COLUMN pack_returned_at DATETIME(3) NULL AFTER paused_at;

CREATE TABLE ai_credit_pack_moves (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  pack_id         CHAR(36)     NOT NULL,
  period_start    DATE         NOT NULL,
  direction       ENUM('draw', 'return') NOT NULL,
  credits         INT UNSIGNED NOT NULL,
  created_at      DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_credit_pack_moves_org_id (organization_id, id),
  KEY ix_ai_credit_pack_moves_period (organization_id, period_start, pack_id),
  KEY ix_ai_credit_pack_moves_pack (organization_id, pack_id, created_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ai_credit_pack_requests (
  id                         CHAR(36)         NOT NULL,
  organization_id            CHAR(36)         NOT NULL,
  requested_by_membership_id CHAR(36)         NOT NULL,
  status                     ENUM('open', 'granted', 'declined') NOT NULL,
  open_slot                  TINYINT UNSIGNED NULL,
  pack_id                    CHAR(36)         NULL,
  decided_by_user_id         CHAR(36)         NULL,
  requested_at               DATETIME(3)      NOT NULL,
  decided_at                 DATETIME(3)      NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_credit_pack_requests_org_id (organization_id, id),
  UNIQUE KEY uq_ai_credit_pack_requests_open (organization_id, open_slot),
  KEY ix_ai_credit_pack_requests_status (status, requested_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
