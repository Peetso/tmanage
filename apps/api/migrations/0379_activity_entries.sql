-- 0379_activity_entries — activity history per project and per client (62-A2, B02).
--
-- ## What this migration is for
--
-- `audit_events` names the row an action was about (`object_type`, `object_id`) but not the
-- project or the client it belongs to, so "what happened on this project / for this client" cannot
-- be read from it. The worker job `activity-projector` walks `audit_events` by cursor and files each
-- catalogued action (`packages/domain/src/activity/activity-catalog.ts`) under its project and
-- client here. No write path changes and the chained audit table is not touched; running the
-- cursor from the start back-fills the history.
--
-- - `activity_entries` (TENANT): one row per projected audit event. `source_audit_id` is unique,
--   so projecting the same audit row twice writes one entry (`INSERT IGNORE`). An entry holds ids,
--   the action, its kind and an audience class — never a title, a body or metadata. `project_id`
--   is the project the source row belongs to; `client_organization_id` is set only when the source
--   row itself names a client (invoice, quote, expense, client request, client file): a project's
--   clients are joined at read through `project_clients`, so a re-shared project needs no rewrite.
-- - `activity_projection_cursors` (TENANT): one row per organization, where the projector stopped
--   in that organization's `(created_at, id)` order. It moves in the same transaction as the
--   entries it covers, so an interrupted run resumes without a gap or a duplicate.
--
-- The read (`modules/activity`) authorises the project or client first and then re-checks every
-- entry through its source row's own read rule; the class below is for filtering only.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATETIME(3), ENUM with literal values, no CHECK, no generated column, no JSON
-- column, no functional or partial index, no trigger, no foreign key (the 0257 convention).
-- Each statement is one CREATE; the migrator resumes an interrupted file at its first unapplied
-- statement and treats "already exists" on that one statement as applied.

CREATE TABLE activity_entries (
  id                     CHAR(36)     NOT NULL,
  organization_id        CHAR(36)     NOT NULL,
  project_id             CHAR(36)     NULL,
  client_organization_id CHAR(36)     NULL,
  object_type            VARCHAR(64)  NOT NULL,
  object_id              CHAR(36)     NOT NULL,
  action                 VARCHAR(190) NOT NULL,
  kind                   VARCHAR(32)  NOT NULL,
  actor_user_id          CHAR(36)     NULL,
  audience_class         ENUM('internal', 'client_visible', 'finance') NOT NULL,
  occurred_at            DATETIME(3)  NOT NULL,
  source_audit_id        CHAR(36)     NOT NULL,
  created_at             DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_activity_entries_org_id (organization_id, id),
  UNIQUE KEY uq_activity_entries_source (source_audit_id),
  KEY ix_activity_entries_project_time (organization_id, project_id, occurred_at, id),
  KEY ix_activity_entries_client_time (organization_id, client_organization_id, occurred_at, id),
  KEY ix_activity_entries_object (organization_id, object_type, object_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE activity_projection_cursors (
  id              CHAR(36)    NOT NULL,
  organization_id CHAR(36)    NOT NULL,
  last_created_at DATETIME(3) NULL,
  last_event_id   CHAR(36)    NULL,
  updated_at      DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_activity_projection_cursors_org_id (organization_id, id),
  UNIQUE KEY uq_activity_projection_cursors_org (organization_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
