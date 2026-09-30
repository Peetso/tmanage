-- 0177_project_dependencies — the directed dependency edge between two projects (PROJ, x309).
--
-- Migration number: the pass-26 queue header assigns **0177** to x309. The migrator applies files in
-- ascending numeric order and a gap is not an error (it rejects only a NEW file numbered *below* an
-- applied one), so 0177 on top of the branch base is correct. If integration renumbers a sibling's
-- reservation, the integrator renumbers this file with it; nothing here depends on the literal 0177
-- beyond the filename.
--
-- Governing sources: 38-MODULE-MAP §Projects & portfolio (cross-project dependencies), 22-SCREEN
-- §Portfolio, 07-DATA-MODEL §9 (index prefixes lead with `organization_id`),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- A row records that one project blocks another: `blocker_project_id` blocks `blocked_project_id`
-- (equivalently, the blocked project depends on the blocker). It is deliberately *only* the linkage
-- plus an optional human `note` — no scheduling roll-up, no auto-status. A row is created (link) and
-- removed (unlink); it is never edited, so the runtime credential holds INSERT and DELETE and nothing
-- else (see `users.sql`), the posture `milestone_links` (0108) and `objective_work_links` (0047)
-- carry. Distinct from `work_dependencies_blockers` (item-level) and `milestone_links`
-- (milestone-level): this edge is between two whole projects.
--
-- ## Tenant-scoped, and both ends bound to the same tenant
--
-- `organization_id` is NOT NULL and every column is tenant-owned. Two composite foreign keys bind
-- `(organization_id, blocker_project_id)` and `(organization_id, blocked_project_id)` to `projects`,
-- so an edge can only ever name projects of its *own* tenant — a cross-tenant id does not exist as a
-- pair even when both ids exist individually. The service resolves BOTH ids tenant-scoped BEFORE it
-- authorizes and writes, and refuses an unknown id with a 404, so the foreign keys are the backstop,
-- not the primary check. A self-dependency (`blocker == blocked`) is rejected in the service (400);
-- the composite keys cannot express that, so the invariant lives in code.
--
-- ## One edge per pair
--
-- A `(organization_id, blocker_project_id, blocked_project_id)` unique key makes a duplicate edge a
-- 409 the service returns rather than a second row.

CREATE TABLE project_dependencies (
  id                    CHAR(36)      NOT NULL,
  organization_id       CHAR(36)      NOT NULL,
  -- The project that blocks the other. NOT NULL: an edge needs both ends.
  blocker_project_id    CHAR(36)      NOT NULL,
  -- The project that is blocked (it depends on the blocker). NOT NULL for the same reason.
  blocked_project_id    CHAR(36)      NOT NULL,
  -- An optional human note explaining the dependency. NULL when none was given.
  note                  VARCHAR(500)  NULL,
  -- Who created the dependency, for provenance. The service passes `context.userId`.
  created_by            CHAR(36)      NOT NULL,
  created_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_project_dependencies_org_id (organization_id, id),
  -- One edge per (blocker, blocked) within a tenant: a duplicate is a 409, not a row.
  UNIQUE KEY uq_project_dependencies_pair (organization_id, blocker_project_id, blocked_project_id),
  -- The index the "projects this one blocks" list reads, leading with `organization_id`
  -- per 07-DATA-MODEL §9.
  KEY ix_project_dependencies_org_blocker (organization_id, blocker_project_id, created_at),
  -- The index the "projects that block this one" list reads.
  KEY ix_project_dependencies_org_blocked (organization_id, blocked_project_id, created_at),
  CONSTRAINT fk_project_dependencies_blocker_tenant
    FOREIGN KEY (organization_id, blocker_project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_project_dependencies_blocked_tenant
    FOREIGN KEY (organization_id, blocked_project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_project_dependencies_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
