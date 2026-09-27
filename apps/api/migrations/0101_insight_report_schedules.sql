-- 0101_insight_report_schedules — a member's own recurring insights-report definition (module 15
-- Insights & reporting, INS report schedules, x228).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Insights & reporting; the insights
-- reads and the saved views already exist (x109/x120/x123/x133–x135, x210), but a person cannot say
-- "run the delivery-flow report every Monday at 08:00" — this store is that recurring definition.
-- Shape follows `insight_saved_views` (0089, WK): owner- and tenant-scoped, private to its creator.
--
-- ## Definition only — no dispatcher, no egress
--
-- This slice ships the definition and a computed `next_run_at`, not a runner. There is no scheduler,
-- no email and no outbound call anywhere in the slice (a dispatcher is a later, Needs-Peter concern):
-- the row records *when the report is next due* so a future dispatcher can find due rows, and nothing
-- more. `next_run_at` is computed by the application from a bound `now` (report-schedules.service.ts),
-- never the server clock, the admin-pool-clock trap the sibling snapshots (0090) call out.
--
-- ## Migration number
--
-- The pass-23 migration map reserves 0101 for x228. The migrator applies files in ascending numeric
-- order and a gap is not an error (it rejects only a NEW file numbered below an applied one), so 0101
-- on top of the highest migration present on this slice's base is correct.
--
-- ## One row per schedule, private to its owner in one studio
--
-- A row is one person's recurring report definition in one studio, `(organization_id, owner_user_id)`-
-- scoped and registered in the query guard's TENANT_TABLES. The list, create and delete are all scoped
-- by `owner_user_id = the acting user`, so one member never sees or removes another's schedule even
-- inside the same tenant. The composite FK binds the row to this organization.
--
-- ## report_key and cadence are closed vocabularies; the clock fields are validated by the app
--
-- `report_key` is the ENUM the application mirrors in `INSIGHT_REPORT_KINDS` (schema.ts) — the same
-- fixed set of insights reports the saved views name. `cadence` is `daily` or `weekly`. `hour` is
-- 0–23 and, for a weekly schedule, `day_of_week` is 0–6 (0=Sunday); a daily schedule leaves
-- `day_of_week` NULL. Range validation is the application's (report-schedules.controller.ts): an
-- out-of-range hour, a weekly schedule with no day, or an unknown key is a 400 before any write.
--
-- ## Create and delete only; identity is what a row is
--
-- This slice ships create/list/delete — a schedule is defined once and removed, never edited in place
-- — so the app is granted INSERT and DELETE and no UPDATE (scripts/db/users.sql). With no UPDATE path,
-- `organization_id`/`owner_user_id` cannot move at the runtime credential, so no BEFORE UPDATE trigger
-- is added (the `insight_saved_views` 0089 precedent for a never-amended, owner-scoped table).

CREATE TABLE insight_report_schedules (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The user who owns this schedule. Private to them: the list, create and delete are all scoped by
  -- owner_user_id = the acting context's user, so one member never sees or removes another's schedule
  -- even inside the same tenant. `owner_user_id` is the global user id, as `insight_saved_views` uses.
  owner_user_id   CHAR(36)     NOT NULL,
  -- The insights report this schedule runs, a closed vocabulary mirrored by `INSIGHT_REPORT_KINDS` in
  -- schema.ts. The application rejects an unknown key with a 400 before any write.
  report_key      ENUM('portfolio','delivery-flow','approval-cycle','workload','adoption','forecast')
                               NOT NULL,
  -- How often the report repeats. `weekly` uses day_of_week; `daily` ignores it (stored NULL).
  cadence         ENUM('daily','weekly') NOT NULL,
  -- The hour of day the report runs, 0–23 (UTC). Range-validated by the application.
  hour            TINYINT      NOT NULL,
  -- The day of week a weekly schedule lands on, 0–6 (0=Sunday). NULL for a daily schedule.
  day_of_week     TINYINT      NULL,
  -- The next instant this schedule is due, computed by the application from a bound `now` (never the
  -- server clock) and stored so a future dispatcher can find due rows. No dispatcher exists this slice.
  next_run_at     DATETIME(3)  NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries (and the isolation corpus requires).
  UNIQUE KEY uq_insight_report_schedules_org_id (organization_id, id),
  -- The list index: one owner's schedules in one studio, in id order.
  KEY ix_insight_report_schedules_org_owner (organization_id, owner_user_id, id),
  CONSTRAINT fk_insight_report_schedules_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
