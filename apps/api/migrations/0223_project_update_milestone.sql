-- 0223_project_update_milestone — a project update may name the milestone it reports on
-- (Figma 376:17695 task 6, "Published update card": the grey "Linked: <milestone> · due <date>").
--
-- `project_updates` (0041) carries no link to `project_milestones` (0048). This adds one nullable
-- column: an update without a linked milestone stays exactly as it was.
--
-- ## Why there is no foreign key
--
-- A milestone may be deleted (the milestone lifecycle), and a composite `(organization_id,
-- milestone_id)` key cannot `ON DELETE SET NULL` without nulling `organization_id` too, which is
-- NOT NULL. A restrictive key would make deleting a milestone that an update mentions fail. So the
-- service resolves the milestone inside this tenant and requires it to belong to the update's own
-- project before it is written, and the read joins it tenant-scoped: a link whose milestone has gone
-- simply reads as "no linked milestone".
--
-- MariaDB-safe: one plain nullable column and one plain index; no generated column, no CHECK, no
-- functional index.

ALTER TABLE project_updates
  ADD COLUMN milestone_id CHAR(36) NULL AFTER body,
  ADD KEY ix_project_updates_org_milestone (organization_id, milestone_id);
