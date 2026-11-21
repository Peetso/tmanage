-- 0402_ai_excluded_projects — "AI may not read this project" (plan 60 v2, 60-02, M5).
--
-- Plan 60 v2 §4.6 step 6: every agent call checks that the project is one of the AI employee's
-- projects **and is not excluded for AI**. One row per excluded project of a workspace; deleting
-- the row lifts the exclusion (the change is audited by the service, DA-11). An exclusion applies
-- to every AI employee of the workspace, whatever its project memberships say, and the project
-- context listing (60-22) honours it.
--
-- `set_by_membership_id`: the person who excluded it (never an AI). `created_at`: a bound value
-- (DA-10). The primary key `(organization_id, project_id)` is the natural idempotency key (HT-4):
-- excluding twice is one row.
--
-- MariaDB-safe (DA-5): one CREATE TABLE, no CHECK, no generated column, no trigger, no foreign key
-- (the 0257 convention). Additive only (DA-6).

CREATE TABLE ai_excluded_projects (
  organization_id      CHAR(36)    NOT NULL,
  project_id           CHAR(36)    NOT NULL,
  set_by_membership_id CHAR(36)    NOT NULL,
  created_at           DATETIME(3) NOT NULL,
  PRIMARY KEY (organization_id, project_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
