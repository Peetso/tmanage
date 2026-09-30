-- 0162_project_baselines — PROJ / module 8 (x295): the project milestone-plan baseline.
--
-- Governing sources: 22-SCREEN (PRJ timeline baseline), 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP
-- §Projects, 11-USER-STORIES (portfolio), 23-ERD §2 (`PROJECT ||--o{ …` project-owned records),
-- 07-DATA-MODEL §9 (index prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §5-7 (composite tenant keys, scoped writes), ADR-0001 (MySQL has no row-level
-- security; layers 3-5 replace it).
--
-- ## Migration numbering
--
-- Numbered 0162 as reserved by pass25-queue.txt (migration map: x295 = 0162). The number is a set
-- member, not a position (migrator.db.test treats gaps as legitimate), so the integrator renumbers
-- this file only if a collision appears after the parallel merges.
--
-- ## What this migration is for
--
-- A project manager wants to snapshot the current milestone plan — each milestone's target date —
-- as a named baseline, then later read a variance view comparing today's dates to the baseline
-- (slippage). This is the smallest durable unit that holds such a snapshot: a **project baseline**
-- — a label, the freezing user and instant, and a frozen `snapshot` of `[{milestoneId, targetDate}]`
-- captured from `project_milestones` (0048) at snapshot time.
--
-- ## Immutable snapshot: append-only, never updated
--
-- A baseline is a point-in-time record. Once frozen it is never edited — variance is recomputed at
-- read time from the live milestones against the frozen JSON, so the snapshot itself never changes.
-- The runtime credential is therefore granted INSERT and DELETE (create a baseline, discard a
-- superseded one) but **no UPDATE** (users.sql). There is no `updated_at` column and no update
-- trigger: a snapshot that cannot be mutated needs neither.
--
-- ## Project-owned, and tenant-scoped like every sibling
--
-- `project_baselines.project_id` is `NOT NULL`: a baseline belongs to a project, the way a milestone
-- (0048) does. The composite foreign key `fk_project_baselines_project_tenant` binds
-- `(organization_id, project_id)` to `projects`, so a baseline can only ever name a project of its
-- own tenant — a cross-tenant project id does not exist as a pair even when both ids exist
-- individually, so a caller can never freeze a baseline against another studio's project.

CREATE TABLE project_baselines (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- NOT NULL. A baseline belongs to a project; see the note above.
  project_id         CHAR(36)     NOT NULL,
  -- The caller's name for the snapshot ("Kickoff plan", "Q3 re-baseline"). A short handle, like
  -- `project_milestones.title`.
  label              VARCHAR(300) NOT NULL,
  -- The frozen plan: a JSON array of `{"milestoneId": "...", "targetDate": "YYYY-MM-DD" | null}`,
  -- captured from `project_milestones` at snapshot time. Immutable once written; variance is
  -- recomputed at read time against the live milestones.
  snapshot           JSON         NOT NULL,
  created_by         CHAR(36)     NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_project_baselines_org_id (organization_id, id),
  -- 07-DATA-MODEL §9: the one read that exists — this tenant's baselines for this project, newest
  -- first. Leads with `organization_id`.
  KEY ix_project_baselines_org_project (organization_id, project_id, created_at),
  CONSTRAINT fk_project_baselines_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_project_baselines_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
