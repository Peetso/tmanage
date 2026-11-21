-- 0399_ai_employees — the companion row of an AI employee (plan 60 v2, 60-02, M2).
--
-- One row per `memberships` row of kind `ai` (0398). The membership carries the role and the
-- project memberships like any member; this row carries what only an AI employee has:
--
-- - `sponsor_membership_id`: the person who answers for it (never an AI; re-checked on every
--   call, so the AI never holds more than its sponsor, `aiEffectiveCapabilities`).
-- - `created_by_membership_id`: who hired it.
-- - `job_title`, `department_key`: what it does, shown in People; the department key is one of the
--   catalogue's departments (60-13) or NULL.
-- - `vendor_label`, `model_label`: disclosed by the owner, free text ("Claude", "ChatGPT", an
--   automation tool); shown, never trusted.
-- - `status` (`active / paused / retired`, `aiEmployeeStateMachine`), `paused_reason` (one of
--   `AI_EMPLOYEE_PAUSE_REASONS`), `paused_at`, `retired_at`, `retired_by_membership_id`. Retired is
--   final; the row and the membership are never deleted while the company exists.
-- - `allowed_task_types_json`: the task type keys it may be assigned (60-13/60-15); NULL = none yet.
-- - `timezone` and `working_hours_json` (`parseWorkingHours` windows; NULL = always).
-- - `limits_json` (`parseAiEmployeeLimits`; NULL = the defaults of §4.9).
-- - `disclose_to_clients`: "Prepared with AI, reviewed by ..." in the portal (open question 5,
--   default on).
-- - `version`: optimistic concurrency for every edit (DA-1, conditional UPDATE ... WHERE version = ?).
--
-- JSON is stored as LONGTEXT and parsed in the service (IP-2): MariaDB's JSON type is an alias that
-- adds a CHECK constraint, which this repo keeps out of migrations (DA-5).
--
-- MariaDB-safe (DA-5): one CREATE TABLE, ENUM with literal values, literal defaults, no CHECK, no
-- generated column, no functional or partial index, no trigger, no foreign key (the 0257
-- convention). Times are bound values from the API (DA-10). Additive only (DA-6).

CREATE TABLE ai_employees (
  id                       CHAR(36)     NOT NULL,
  organization_id          CHAR(36)     NOT NULL,
  membership_id            CHAR(36)     NOT NULL,
  user_id                  CHAR(36)     NOT NULL,
  sponsor_membership_id    CHAR(36)     NOT NULL,
  created_by_membership_id CHAR(36)     NOT NULL,
  job_title                VARCHAR(120) NOT NULL,
  department_key           VARCHAR(64)  NULL,
  vendor_label             VARCHAR(80)  NULL,
  model_label              VARCHAR(80)  NULL,
  status                   ENUM('active', 'paused', 'retired') NOT NULL DEFAULT 'active',
  paused_reason            VARCHAR(32)  NULL,
  paused_at                DATETIME(3)  NULL,
  retired_at               DATETIME(3)  NULL,
  retired_by_membership_id CHAR(36)     NULL,
  allowed_task_types_json  LONGTEXT     NULL,
  timezone                 VARCHAR(64)  NOT NULL DEFAULT 'UTC',
  working_hours_json       LONGTEXT     NULL,
  limits_json              LONGTEXT     NULL,
  disclose_to_clients      TINYINT(1)   NOT NULL DEFAULT 1,
  version                  BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at               DATETIME(3)  NOT NULL,
  updated_at               DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ai_employees_org_id (organization_id, id),
  UNIQUE KEY uq_ai_employees_org_membership (organization_id, membership_id),
  KEY ix_ai_employees_org_status (organization_id, status),
  KEY ix_ai_employees_org_sponsor (organization_id, sponsor_membership_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
