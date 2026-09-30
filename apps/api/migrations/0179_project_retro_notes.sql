-- 0179_project_retro_notes — FEAT: Project retrospective notes (PROJ / module 8, x311).
--
-- Migration number: the pass-26 queue reserves 0179 for x311. The migrator applies files in
-- ascending numeric order and a gap is not an error (it rejects only a NEW file numbered *below* an
-- applied one), so 0179 on top of the base's highest migration is correct. If integration renumbers
-- the reservation, the integrator renumbers this file with it; nothing here depends on the literal
-- 0179 beyond the filename.
--
-- Governing sources: 38-MODULE-MAP §Projects & portfolio (retrospectives), 22-SCREEN §Project detail,
-- 07-DATA-MODEL §9 (index prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION
-- §6 (composite tenant keys).
--
-- ## Why this is NOT `project_status_updates` (0107) and NOT `project_update_comments` (0084)
--
-- `project_status_updates` (x235) is the studio's running status band changelog (`on_track` /
-- `at_risk` / `off_track`). `project_update_comments` (0084) threads discussion under a published
-- client update. This table is a different thing: a **categorised reflection log** captured during a
-- retrospective — each note is filed under `went_well` / `to_improve` / `action`, carries a free-text
-- `body`, and may optionally reference the milestone the retro was held for. There is no assignment,
-- no status, and no lifecycle: it is an append-oriented log a member reads grouped by category and
-- deletes an individual note from.
--
-- ## Project-owned, tenant-scoped
--
-- `project_retro_notes.project_id` is `NOT NULL`: a note belongs to a project, the way a status
-- update (0107) and a milestone (0048) do. The composite foreign key
-- `fk_project_retro_notes_project_tenant` binds `(organization_id, project_id)` to `projects`, so a
-- note can only ever name a project of its own tenant — a cross-tenant project id does not exist as a
-- pair even when both ids exist individually. The optional `milestone_id` is bound the same way to
-- `project_milestones`, so a referenced milestone is always of this tenant (and the service resolves
-- it tenant-scoped before the insert, mapping an unknown id to 400 rather than a foreign-key 500).
--
-- Unlike the status log (0107), a retro note is deletable: the runtime credential is granted INSERT,
-- DELETE and SELECT (see scripts/db/users.sql), and there is no immutability trigger. There is no
-- edit path in this slice.

CREATE TABLE project_retro_notes (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- NOT NULL. A note belongs to a project; see the note above.
  project_id         CHAR(36)     NOT NULL,
  -- Optional. The milestone the retrospective was held for, when the note is milestone-scoped rather
  -- than whole-project. NULL when the note is about the project as a whole.
  milestone_id       CHAR(36)     NULL,
  -- The retrospective category the note is filed under. A fixed three-point allowlist; there is no
  -- free-form category.
  category           ENUM('went_well','to_improve','action') NOT NULL,
  -- The narrative of the note. `TEXT`; bounded at the application layer (a form field, not a
  -- document). Required — a note with no body is not a note.
  body               TEXT         NOT NULL,
  -- The person who captured the note — the service passes `context.userId`.
  created_by         CHAR(36)     NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_project_retro_notes_org_id (organization_id, id),
  -- The index the board is listed by: this tenant's notes for this project, newest first. Leads with
  -- `organization_id` per 07-DATA-MODEL §9. The list orders by `(created_at, id)` descending; this
  -- covers the range scan.
  KEY ix_project_retro_notes_org_project (organization_id, project_id, created_at, id),
  CONSTRAINT fk_project_retro_notes_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_project_retro_notes_milestone_tenant
    FOREIGN KEY (organization_id, milestone_id) REFERENCES project_milestones (organization_id, id),
  CONSTRAINT fk_project_retro_notes_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
