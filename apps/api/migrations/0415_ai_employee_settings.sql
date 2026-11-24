-- 0415_ai_employee_settings — a workspace's rules for AI employees (plan 60 v2 §4.10 S8, 60-07).
--
-- One row per workspace; no row = the defaults below (the service reads a missing row as them):
--
-- - `enabled`: the workspace switch. Off = every agent call is refused at the agent gate (60-06),
--   nothing is deleted, and revoking a key or a connection still works.
-- - `hire_policy`: who may hire, on top of `ai_employee.manage`: `owners_and_admins` (the
--   capability as granted) or `owners` (only an owner).
-- - `assign_policy`: who may give work to an AI employee, on top of `ai_employee.assign`:
--   `managers` (the capability as granted) or `owners_and_admins`.
-- - `client_work`: `allowed`, or `internal_only` (a project with a client company is never one of
--   an AI employee's projects; the agent gate drops it like an excluded project).
-- - `disclose_to_clients`: the default for a new hire's "Prepared with AI, reviewed by …".
-- - `second_approver`: separation of duties on client work (the person who sponsored the AI and
--   gave it the task may not also approve the result); read by the review slice (60-26).
-- - `version`: optimistic concurrency (DA-1, conditional UPDATE … WHERE version = ?).
--
-- MariaDB-safe (DA-5): one CREATE TABLE, ENUM with literal values, literal defaults, no CHECK, no
-- generated column, no trigger, no foreign key (the 0257 convention). Times are bound values from
-- the API (DA-10). Additive only (DA-6).

CREATE TABLE ai_employee_settings (
  organization_id          CHAR(36)    NOT NULL,
  enabled                  TINYINT(1)  NOT NULL DEFAULT 1,
  hire_policy              ENUM('owners_and_admins', 'owners') NOT NULL DEFAULT 'owners_and_admins',
  assign_policy            ENUM('managers', 'owners_and_admins') NOT NULL DEFAULT 'managers',
  client_work              ENUM('allowed', 'internal_only') NOT NULL DEFAULT 'allowed',
  disclose_to_clients      TINYINT(1)  NOT NULL DEFAULT 1,
  second_approver          TINYINT(1)  NOT NULL DEFAULT 1,
  version                  BIGINT UNSIGNED NOT NULL DEFAULT 1,
  updated_by_membership_id CHAR(36)    NULL,
  updated_at               DATETIME(3) NOT NULL,
  PRIMARY KEY (organization_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
