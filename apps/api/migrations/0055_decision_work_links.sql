-- 0055_decision_work_links — the edge from a decision to the work item it drives (DEC / module 12, x149).
--
-- Migration number: pass 20 reserves 0042…0059 in id order and NEXT-SCOPES-12 assigns **0055** to
-- x149; the highest migration after pass 19 was 0041. The migrator applies files in ascending numeric
-- order and a gap is not an error (it rejects only a NEW file numbered *below* an applied one), so
-- 0055 is correct on this base. If integration renumbers a sibling's reservation, the integrator
-- renumbers this file with it; nothing here depends on the literal 0055 beyond the filename.
--
-- Governing sources: 38-MODULE-MAP §Decisions ("linked actions"), 23-ERD-AND-STATE-MACHINES §2
-- (project-owned records), 07-DATA-MODEL §9 (index prefixes lead with `organization_id`),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- x113 gave a project its decision register; work items already exist. This table is the many-to-many
-- edge between the two: which work items a decision set in motion. It is deliberately *only* the
-- linkage — no auto-creation of follow-up work from a decision (deferred to NS-13). A row is created
-- (link) and removed (unlink); it is never edited, so the runtime credential holds INSERT and DELETE
-- and nothing else (see `users.sql`), the posture `objective_work_links` and `work_item_dependencies`
-- carry.
--
-- ## Tenant-scoped, and both ends bound to the same tenant
--
-- `organization_id` is NOT NULL and every column is tenant-owned. Two composite foreign keys bind
-- `(organization_id, decision_id)` to `decisions` and `(organization_id, work_item_id)` to
-- `work_items`, so an edge can only ever name a decision and a work item of its *own* tenant — a
-- cross-tenant id does not exist as a pair even when both ids exist individually. The service resolves
-- both ids tenant- and project-scoped BEFORE the write and refuses a mismatch with a 404, so the
-- foreign keys are the backstop, not the primary check.
--
-- ## One edge per pair
--
-- A `(organization_id, decision_id, work_item_id)` unique key makes a duplicate link a conflict the
-- service maps to 409 rather than a second identical row.

CREATE TABLE decision_work_links (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- The decision this edge records an action for. NOT NULL: an edge with no decision has nothing to link.
  decision_id        CHAR(36)     NOT NULL,
  -- The work item the decision set in motion. NOT NULL for the same reason.
  work_item_id       CHAR(36)     NOT NULL,
  -- Who linked the two, for provenance. The service passes `context.userId`.
  created_by         CHAR(36)     NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries (delete names the link by id).
  UNIQUE KEY uq_decision_work_links_org_id (organization_id, id),
  -- One edge per (decision, work item) within a tenant: a duplicate link is a 409, not a second row.
  UNIQUE KEY uq_decision_work_links_pair (organization_id, decision_id, work_item_id),
  -- The index the list reads: this tenant's links for one decision, in creation order. Leads with
  -- `organization_id` per 07-DATA-MODEL §9.
  KEY ix_decision_work_links_org_decision (organization_id, decision_id, created_at),
  CONSTRAINT fk_decision_work_links_decision_tenant
    FOREIGN KEY (organization_id, decision_id) REFERENCES decisions (organization_id, id),
  CONSTRAINT fk_decision_work_links_work_item_tenant
    FOREIGN KEY (organization_id, work_item_id) REFERENCES work_items (organization_id, id),
  CONSTRAINT fk_decision_work_links_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
