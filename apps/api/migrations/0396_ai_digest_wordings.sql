-- 0396_ai_digest_wordings — the optional AI wording of a workspace's weekly digest briefing, one per shown set of signals (plan 62, 62-28).
--
-- ## What this migration is for
--
-- Plan 62 §4.8 and §9 62-28: "an optional weekly digest worded by Haiku through the Batch API
-- (half price) only when there are 3 or more signals; default digest is a plain template at zero
-- cost." The API's digest wording job (`copilot/digest/digest-wording-job.ts`), only in a workspace
-- whose `ai_digest_wording` flag is on (off by default), sends the company-wide section's facts
-- in a message batch and stores the checked answer here. The worker's digest reads a `ready` row
-- whose `lines_sha256` equals the reader's own section and shows it above the unchanged template
-- list; anything else gets the template. No row ever widens what a reader sees: the key is the
-- exact set of signals already in their section.
--
-- - `ai_digest_wordings` (TENANT): `lines_sha256` is the SHA-256 of the shown signal ids in order
--   (`digestLinesKey`). `status`: `submitted` (in a batch: `batch_id`, `custom_id`, and the budget
--   task and call that hold its cost), then `ready` (`body`, checked by `checkDigestWording`),
--   `rejected` (the answer failed the check, `reason_code`) or `failed` (the batch errored or
--   expired). `body` holds the wording with `[n]` markers, never ids or links.
--
-- No data is written here.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- One DDL statement, one new table. ENUM with literal values, literal defaults, no CHECK, no
-- generated column, no functional or partial index, no trigger, no foreign key (the 0257
-- convention). Additive only: old code ignores the table (DA-6).

CREATE TABLE ai_digest_wordings (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  lines_sha256    CHAR(64)     NOT NULL,
  line_count      SMALLINT UNSIGNED NOT NULL,
  status          ENUM('submitted', 'ready', 'rejected', 'failed') NOT NULL,
  batch_id        VARCHAR(128) NULL,
  custom_id       VARCHAR(64)  NULL,
  task_id         CHAR(36)     NULL,
  call_id         CHAR(36)     NULL,
  model           VARCHAR(64)  NULL,
  body            TEXT         NULL,
  reason_code     VARCHAR(32)  NULL,
  created_at      DATETIME(3)  NOT NULL,
  updated_at      DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_digest_wordings_org_id (organization_id, id),
  UNIQUE KEY uq_ai_digest_wordings_lines (organization_id, lines_sha256),
  KEY ix_ai_digest_wordings_status (status, created_at, organization_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
