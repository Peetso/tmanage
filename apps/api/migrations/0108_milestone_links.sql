-- 0108_milestone_links — the dependency edge between two project milestones (PROJ / module 8, x236).
--
-- Migration number: the queue header (pass 23) assigns **0108** to x236. The migrator applies files
-- in ascending numeric order and a gap is not an error (it rejects only a NEW file numbered *below*
-- an applied one), so 0108 on top of the branch base is correct. If integration renumbers a
-- sibling's reservation, the integrator renumbers this file with it; nothing here depends on the
-- literal 0108 beyond the filename.
--
-- Governing sources: 38-MODULE-MAP §Projects & portfolio (milestones), 23-ERD-AND-STATE-MACHINES §2
-- (project-owned records), 07-DATA-MODEL §9 (index prefixes lead with `organization_id`),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- Pass 20 (x139, 0048) gave a project its milestones. This table is the "depends-on" edge between
-- two of them: milestone A depends on milestone B (B is a prerequisite of A). It is deliberately
-- *only* the linkage — no scheduling roll-up, no auto-status. A row is created (link) and removed
-- (unlink); it is never edited, so the runtime credential holds INSERT and DELETE and nothing else
-- (see `users.sql`), the posture `objective_work_links` (0047) carries.
--
-- ## Tenant-scoped, and both ends bound to the same tenant
--
-- `organization_id` is NOT NULL and every column is tenant-owned. Two composite foreign keys bind
-- `(organization_id, milestone_id)` and `(organization_id, depends_on_milestone_id)` to
-- `project_milestones`, so an edge can only ever name milestones of its *own* tenant — a cross-tenant
-- id does not exist as a pair even when both ids exist individually. The service resolves BOTH ids
-- tenant-scoped (and in the same project) BEFORE the write and refuses a mismatch with a 404, so the
-- foreign keys are the backstop, not the primary check. Self-links and cycles are rejected in the
-- service (400); the composite keys cannot express "no cycle", so that invariant lives in code.
--
-- ## One edge per pair
--
-- A `(organization_id, milestone_id, depends_on_milestone_id)` unique key makes a duplicate link a
-- no-op the service resolves idempotently (it returns the existing edge) rather than a second row.

CREATE TABLE milestone_links (
  id                        CHAR(36)     NOT NULL,
  organization_id           CHAR(36)     NOT NULL,
  -- The dependent milestone — the one that depends on another. NOT NULL: an edge needs both ends.
  milestone_id              CHAR(36)     NOT NULL,
  -- The prerequisite milestone this one depends on. NOT NULL for the same reason.
  depends_on_milestone_id   CHAR(36)     NOT NULL,
  -- Who created the dependency, for provenance. The service passes `context.userId`.
  created_by                CHAR(36)     NOT NULL,
  created_at                DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_milestone_links_org_id (organization_id, id),
  -- One edge per (milestone, depends-on) within a tenant: a duplicate link is idempotent, not a row.
  UNIQUE KEY uq_milestone_links_pair (organization_id, milestone_id, depends_on_milestone_id),
  -- The index the list reads: this tenant's dependencies for one milestone, in creation order. Leads
  -- with `organization_id` per 07-DATA-MODEL §9.
  KEY ix_milestone_links_org_milestone (organization_id, milestone_id, created_at),
  CONSTRAINT fk_milestone_links_milestone_tenant
    FOREIGN KEY (organization_id, milestone_id) REFERENCES project_milestones (organization_id, id),
  CONSTRAINT fk_milestone_links_depends_on_tenant
    FOREIGN KEY (organization_id, depends_on_milestone_id)
      REFERENCES project_milestones (organization_id, id),
  CONSTRAINT fk_milestone_links_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
