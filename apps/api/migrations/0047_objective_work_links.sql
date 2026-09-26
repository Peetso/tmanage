-- 0047_objective_work_links — the edge from a project objective to a work item (PROJ / module 8, x138).
--
-- Migration number: this slice's base is x124 (`0040_project_objectives`), the highest migration on
-- the branch's base. Pass 20 reserves 0042…0059 in id order and NEXT-SCOPES-12 assigns **0047** to
-- x138. The migrator applies files in ascending numeric order and a gap is not an error (it rejects
-- only a NEW file numbered *below* an applied one), so 0047 on top of 0040 is correct on this base.
-- If integration renumbers a sibling's reservation, the integrator renumbers this file with it;
-- nothing here depends on the literal 0047 beyond the filename.
--
-- Governing sources: 38-MODULE-MAP §Projects ("objectives ↔ work"), 23-ERD-AND-STATE-MACHINES §2
-- (project-owned records), 07-DATA-MODEL §9 (index prefixes lead with `organization_id`),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- x124 gave a project its objectives; work items already exist. This table is the many-to-many edge
-- between the two: which work items advance which objective. It is deliberately *only* the linkage —
-- no progress roll-up from linked work (deferred to NS-13). A row is created (link) and removed
-- (unlink); it is never edited, so the runtime credential holds INSERT and DELETE and nothing else
-- (see `users.sql`), the posture `work_item_dependencies` and `saved_context` carry.
--
-- ## Tenant-scoped, and both ends bound to the same tenant
--
-- `organization_id` is NOT NULL and every column is tenant-owned. Two composite foreign keys bind
-- `(organization_id, objective_id)` to `project_objectives` and `(organization_id, work_item_id)` to
-- `work_items`, so an edge can only ever name an objective and a work item of its *own* tenant — a
-- cross-tenant id does not exist as a pair even when both ids exist individually. The service resolves
-- both ids tenant- and project-scoped BEFORE the write and refuses a mismatch with a 404, so the
-- foreign keys are the backstop, not the primary check.
--
-- ## One edge per pair
--
-- A `(organization_id, objective_id, work_item_id)` unique key makes a duplicate link a conflict the
-- service maps to 409 rather than a second identical row.

CREATE TABLE objective_work_links (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- The objective this edge advances. NOT NULL: an edge with no objective has nothing to link.
  objective_id       CHAR(36)     NOT NULL,
  -- The work item that advances the objective. NOT NULL for the same reason.
  work_item_id       CHAR(36)     NOT NULL,
  -- Who linked the two, for provenance. The service passes `context.userId`.
  created_by         CHAR(36)     NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries (delete names the link by id).
  UNIQUE KEY uq_objective_work_links_org_id (organization_id, id),
  -- One edge per (objective, work item) within a tenant: a duplicate link is a 409, not a second row.
  UNIQUE KEY uq_objective_work_links_pair (organization_id, objective_id, work_item_id),
  -- The index the list reads: this tenant's links for one objective, in creation order. Leads with
  -- `organization_id` per 07-DATA-MODEL §9.
  KEY ix_objective_work_links_org_objective (organization_id, objective_id, created_at),
  CONSTRAINT fk_objective_work_links_objective_tenant
    FOREIGN KEY (organization_id, objective_id) REFERENCES project_objectives (organization_id, id),
  CONSTRAINT fk_objective_work_links_work_item_tenant
    FOREIGN KEY (organization_id, work_item_id) REFERENCES work_items (organization_id, id),
  CONSTRAINT fk_objective_work_links_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
