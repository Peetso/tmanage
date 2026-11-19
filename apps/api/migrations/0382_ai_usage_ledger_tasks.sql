-- 0382_ai_usage_ledger_tasks — one row per AI task and one per model call (plan 62, 62-05, B08).
--
-- ## What this migration is for
--
-- - `ai_tasks` (TENANT): one request of a member, from the price shown before it to the receipt
--   after it. `tier` is fixed when the task starts (no silent upgrade); `activity` is the
--   dashboard breakdown ('tasks', 'clients', 'time_billing', 'file_analysis', 'knowledge',
--   'support'; vocabulary checked in code). `pool` is the pool the server chose from the caller's
--   class, never from the request. `ceiling_credits` is the tier ceiling held; `charged_credits`
--   the credits taken from the workspace (0 for failed, refused, timed out or cancelled work, which
--   the platform pays); `refunded_credits` / `refunded_at` record an undo. `cost_micro_usd` is the
--   real cost of all its calls (what the pool paid). `receipt_json` is the receipt shown under the
--   answer and `undo_json` what an undo needs — ids and captured values, never question, answer or
--   argument text.
-- - `ai_usage_ledger` (TENANT): one row per model call, written as a hold before the call and
--   completed after it: 'reserved' -> 'sent' -> 'settled', or 'released' (never sent) / 'expired'
--   (a lost hold; sent with an unknown result settles in full). Every usage bucket of the price
--   table is kept (`input_tokens`, the two cache-write TTLs, `cache_read_tokens`, `output_tokens`
--   with thinking), with the model, the price table version, tool calls, latency and stop reason,
--   so each cost can be recomputed. No prompt or completion text is stored.
--
-- `ix_ai_usage_ledger_open_holds` serves the sweeper that expires lost holds; the org/time keys
-- serve the owner dashboard and the platform AI-spend page. No data is written here.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- New tables only, one CREATE per statement (resumable as 0381). Plain columns, DATETIME(3), ENUM
-- with literal values, JSON columns (MariaDB's alias, as 0275), literal defaults, no CHECK, no
-- generated column, no functional or partial index, no trigger, no foreign key (0257 convention).

CREATE TABLE ai_tasks (
  id               CHAR(36)        NOT NULL,
  organization_id  CHAR(36)        NOT NULL,
  membership_id    CHAR(36)        NOT NULL,
  tier             ENUM('help', 'low', 'medium', 'medium_high', 'high') NOT NULL,
  activity         VARCHAR(32)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  pool             ENUM('customers', 'testing', 'reserve', 'packs') NOT NULL,
  status           ENUM('running', 'completed', 'failed', 'refused', 'cancelled', 'undone') NOT NULL,
  ceiling_credits  INT UNSIGNED    NOT NULL,
  charged_credits  INT UNSIGNED    NOT NULL DEFAULT 0,
  refunded_credits INT UNSIGNED    NOT NULL DEFAULT 0,
  cost_micro_usd   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  receipt_json     JSON            NULL,
  undo_json        JSON            NULL,
  started_at       DATETIME(3)     NOT NULL,
  finished_at      DATETIME(3)     NULL,
  refunded_at      DATETIME(3)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_tasks_org_id (organization_id, id),
  KEY ix_ai_tasks_org_started (organization_id, started_at, id),
  KEY ix_ai_tasks_member_started (organization_id, membership_id, started_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ai_usage_ledger (
  id                    CHAR(36)          NOT NULL,
  organization_id       CHAR(36)          NOT NULL,
  task_id               CHAR(36)          NOT NULL,
  membership_id         CHAR(36)          NOT NULL,
  pool                  ENUM('customers', 'testing', 'reserve', 'packs') NOT NULL,
  pool_period_start     DATE              NOT NULL,
  status                ENUM('reserved', 'sent', 'settled', 'released', 'expired') NOT NULL,
  model                 VARCHAR(64)       CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  price_table_version   VARCHAR(16)       CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  hold_micro_usd        BIGINT UNSIGNED   NOT NULL,
  hold_credits          INT UNSIGNED      NOT NULL,
  cost_micro_usd        BIGINT UNSIGNED   NULL,
  input_tokens          INT UNSIGNED      NOT NULL DEFAULT 0,
  cache_write_5m_tokens INT UNSIGNED      NOT NULL DEFAULT 0,
  cache_write_1h_tokens INT UNSIGNED      NOT NULL DEFAULT 0,
  cache_read_tokens     INT UNSIGNED      NOT NULL DEFAULT 0,
  output_tokens         INT UNSIGNED      NOT NULL DEFAULT 0,
  tool_calls            SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  latency_ms            INT UNSIGNED      NULL,
  stop_reason           VARCHAR(32)       CHARACTER SET ascii COLLATE ascii_bin NULL,
  provider_message_id   VARCHAR(64)       CHARACTER SET ascii COLLATE ascii_bin NULL,
  reserved_at           DATETIME(3)       NOT NULL,
  hold_expires_at       DATETIME(3)       NOT NULL,
  sent_at               DATETIME(3)       NULL,
  settled_at            DATETIME(3)       NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_usage_ledger_org_id (organization_id, id),
  KEY ix_ai_usage_ledger_task (organization_id, task_id),
  KEY ix_ai_usage_ledger_org_reserved (organization_id, reserved_at, id),
  KEY ix_ai_usage_ledger_pool_period (pool, pool_period_start, reserved_at),
  KEY ix_ai_usage_ledger_open_holds (status, hold_expires_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
