-- 0089_insight_saved_views — a member's own named, saved insights filter set (module 15
-- Insights & reporting, INS saved views, x210).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Insights & reporting; the insights
-- reads already exist (delivery-flow/adoption/forecast/workload/CSV, x109/x120/x123/x133–x135) but a
-- person cannot name and re-open a report configuration — this store is that named view. Shape follows
-- `saved_views` (0034, WK-08): owner- and tenant-scoped, the configuration stored whole as JSON and
-- echoed back rather than interpreted here.
--
-- ## Migration number
--
-- NEXT-SCOPES-14 reserves 0089 for x210 (pass 22). The migrator applies files in ascending numeric
-- order and a gap is not an error (it rejects only a NEW file numbered *below* an applied one), so
-- 0089 on top of the highest migration present on this slice's base is correct. If the integration
-- renumbers the reservations, the integrator renumbers this file with them; nothing here depends on
-- the literal 0089 beyond the filename.
--
-- ## One row per saved view, private to its owner in one studio
--
-- A row is one person's saved insights view in one studio, `(organization_id, owner_user_id)`-scoped
-- and registered in the query guard's TENANT_TABLES. Unlike `saved_views` (0034) there is no `shared`
-- flag: an insights view is private to its creator this slice — the list, create and delete are all
-- scoped by `owner_user_id = the acting user`, so one member never sees or removes another's view even
-- inside the same tenant. The composite FK binds the row to this organization.
--
-- ## report_kind is a closed vocabulary; filters is the configuration, stored whole
--
-- `report_kind` is the ENUM the application mirrors in `INSIGHT_REPORT_KINDS` (schema.ts) — the fixed
-- set of insights reports a view may name. `filters` is the remembered filter set, a small object read
-- and written as one and never queried across rows, so it is one JSON column. Shape validation is the
-- application's (`saved-views.controller.ts`), the same division `saved_views.config` (0034) and
-- `work_forms.fields_json` (0052) use.
--
-- ## Create and delete only; identity is what a row is
--
-- This slice ships create/list/delete — a view is named once and removed, never edited in place — so
-- the app is granted INSERT and DELETE and no UPDATE (scripts/db/users.sql). With no UPDATE path,
-- `organization_id`/`owner_user_id` cannot move at the runtime credential, so no BEFORE UPDATE trigger
-- is added (the `maintenance_windows` 0080 precedent for an append-only, never-amended table).

CREATE TABLE insight_saved_views (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The user who owns this view. Private to them: the list, create and delete are all scoped by
  -- owner_user_id = the acting context's user, so one member never sees or removes another's view even
  -- inside the same tenant. `owner_user_id` is the global user id, the shape `saved_views` (0034) uses.
  owner_user_id   CHAR(36)     NOT NULL,
  -- The view's display name, a person's label for a report configuration.
  name            VARCHAR(300) NOT NULL,
  -- The insights report this view names, a closed vocabulary mirrored by `INSIGHT_REPORT_KINDS` in
  -- schema.ts. The application rejects an unknown kind with a 400 before any write.
  report_kind     ENUM('portfolio','delivery-flow','approval-cycle','workload','adoption','forecast')
                               NOT NULL,
  -- The remembered filter set, stored whole: a small `{ "<field>": "<value>" }` object. Shape is
  -- validated by the application; the column stores it whole and never queries across rows.
  filters         JSON         NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries (and the isolation corpus requires).
  UNIQUE KEY uq_insight_saved_views_org_id (organization_id, id),
  -- The list index: one owner's views in one studio, in id order.
  KEY ix_insight_saved_views_org_owner (organization_id, owner_user_id, id),
  CONSTRAINT fk_insight_saved_views_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
