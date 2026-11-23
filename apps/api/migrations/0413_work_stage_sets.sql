-- 0413_work_stage_sets — renamable stages and own stage sets per workspace, project and work
-- (work area plan 2026-11-23, decision D1 and D1b; lane WA slice W-API-2).
--
-- ## What this migration is for
--
-- The owner asked for stages a company can rename, and for a project (or a single work) to use
-- its own set of stages, e.g. "Brief · Concept · Design · Client review · Delivered". The work
-- item state machine (`packages/domain/src/state-machines/work-item.ts`) stays exactly as it is:
-- a stage is a **named place inside one of the machine's states**. Every stage carries the
-- `state_key` it belongs to, so moving a work to a stage runs the ordinary transition to that
-- state; the supervisor rule, the audit trail and every report keep working unchanged.
--
-- - `work_stage_sets` (TENANT): a named, ordered set of stages. `scope` says where it was made
--   ('workspace', 'project', 'custom'); `project_id` names the project a 'project' set belongs to,
--   whose managers may edit it (NULL for the others, which are workspace settings). `default_marker` is 1 on the workspace default and NULL on
--   every other set, so the unique key `(organization_id, default_marker)` holds "at most one
--   default per workspace" in the engine without a partial index (MariaDB has none). `version` is
--   the compare-and-set token (DA-1).
-- - `work_stages` (TENANT): one stage of a set. `state_key` is one of `backlog`, `ready`,
--   `in_progress`, `internal_review`, `done` (the service holds the allowlist; `blocked` and
--   `archived` stay system states, never stages). `color_key` names a token of the design palette.
-- - `work_stage_set_projects` (TENANT): which set a project uses. A link table rather than a
--   column on `projects`, because `projects` has one writer, the projects module (AR-11); the
--   primary key `(organization_id, project_id)` means one set per project.
-- - `work_items.stage_set_id` (a work that uses its own set; NULL = the project's or the
--   workspace's) and `work_items.stage_id` (the stage the work is in; NULL = the first stage of its
--   set with the work's state). Both are written only by the work-items repository.
--
-- ## Data: the old board columns become the workspace default (D1b)
--
-- `work_board_columns` (0176) was a display grouping with the same idea and no editor. A
-- workspace that defined columns gets one default set holding them, in order. Columns on the
-- system states `blocked` / `archived` are not stages and are skipped; only the first `done`
-- column is copied (a set has exactly one "Done" stage). A copied set that has no `in_progress`
-- or no `done` stage gets one, so every set obeys the editor's rules from the start. The old
-- table stays (expand–contract, DA-6): it is removed in a later contract migration, after the
-- web stops reading it.
--
-- ## MariaDB-safe (live is MariaDB 11.8) and re-runnable
--
-- No CHECK, no generated column, no functional or partial index, no trigger, no foreign key (the
-- 0257 convention). The `work_items` change adds two NULL columns and one index online
-- (ALGORITHM=INPLACE, LOCK=NONE; DA-7). Every data statement is guarded by NOT EXISTS, so a re-run
-- after a stop in the middle writes nothing twice (DA-8). Additive only: the previous release
-- ignores the new tables and columns (DA-6).

CREATE TABLE IF NOT EXISTS work_stage_sets (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  name            VARCHAR(120) NOT NULL,
  scope           VARCHAR(16)  NOT NULL,
  project_id      CHAR(36)     NULL,
  default_marker  TINYINT(1)   NULL,
  version         INT          NOT NULL DEFAULT 1,
  created_at      DATETIME(3)  NOT NULL,
  updated_at      DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_work_stage_sets_org_id (organization_id, id),
  UNIQUE KEY uq_work_stage_sets_org_name (organization_id, name),
  UNIQUE KEY uq_work_stage_sets_org_default (organization_id, default_marker),
  KEY ix_work_stage_sets_project (organization_id, project_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS work_stages (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  stage_set_id    CHAR(36)     NOT NULL,
  name            VARCHAR(120) NOT NULL,
  state_key       VARCHAR(32)  NOT NULL,
  color_key       VARCHAR(24)  NULL,
  position        INT          NOT NULL,
  created_at      DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_work_stages_org_id (organization_id, id),
  UNIQUE KEY uq_work_stages_set_name (organization_id, stage_set_id, name),
  KEY ix_work_stages_set_position (organization_id, stage_set_id, position)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS work_stage_set_projects (
  organization_id CHAR(36)    NOT NULL,
  project_id      CHAR(36)    NOT NULL,
  stage_set_id    CHAR(36)    NOT NULL,
  updated_at      DATETIME(3) NOT NULL,
  PRIMARY KEY (organization_id, project_id),
  KEY ix_work_stage_set_projects_set (organization_id, stage_set_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE work_items
  ADD COLUMN stage_set_id CHAR(36) NULL,
  ADD COLUMN stage_id     CHAR(36) NULL,
  ADD KEY ix_work_items_org_stage (organization_id, stage_id),
  ALGORITHM=INPLACE, LOCK=NONE;

-- D1b: one default set per workspace that defined board columns.
INSERT INTO work_stage_sets (id, organization_id, name, scope, default_marker, version, created_at, updated_at)
SELECT UUID(), c.organization_id, 'Workspace stages', 'workspace', 1, 1, MIN(c.created_at), MIN(c.created_at)
FROM work_board_columns c
WHERE NOT EXISTS (
  SELECT 1 FROM work_stage_sets s
  WHERE s.organization_id = c.organization_id AND s.default_marker = 1
)
GROUP BY c.organization_id;

-- The columns as stages, in their order; the system states are skipped, one "Done" only.
INSERT INTO work_stages (id, organization_id, stage_set_id, name, state_key, color_key, position, created_at)
SELECT UUID(), c.organization_id, s.id, LEFT(c.label, 120), c.state_key, NULL, c.position, c.created_at
FROM work_board_columns c
INNER JOIN work_stage_sets s
  ON s.organization_id = c.organization_id AND s.default_marker = 1
WHERE c.state_key IN ('backlog', 'ready', 'in_progress', 'internal_review', 'done')
  AND NOT (
    c.state_key = 'done' AND EXISTS (
      SELECT 1 FROM work_board_columns d
      WHERE d.organization_id = c.organization_id AND d.state_key = 'done'
        AND d.position < c.position
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM work_stages t
    WHERE t.organization_id = c.organization_id AND t.stage_set_id = s.id AND t.name = LEFT(c.label, 120)
  );

-- Every copied set gets the "In progress" and "Done" stages the editor requires.
INSERT INTO work_stages (id, organization_id, stage_set_id, name, state_key, color_key, position, created_at)
SELECT UUID(), s.organization_id, s.id, 'In progress', 'in_progress', NULL, 500, s.created_at
FROM work_stage_sets s
WHERE s.default_marker = 1
  AND NOT EXISTS (
    SELECT 1 FROM work_stages t
    WHERE t.organization_id = s.organization_id AND t.stage_set_id = s.id
      AND (t.state_key = 'in_progress' OR t.name = 'In progress')
  );

INSERT INTO work_stages (id, organization_id, stage_set_id, name, state_key, color_key, position, created_at)
SELECT UUID(), s.organization_id, s.id, 'Done', 'done', NULL, 1000, s.created_at
FROM work_stage_sets s
WHERE s.default_marker = 1
  AND NOT EXISTS (
    SELECT 1 FROM work_stages t
    WHERE t.organization_id = s.organization_id AND t.stage_set_id = s.id
      AND (t.state_key = 'done' OR t.name = 'Done')
  );
