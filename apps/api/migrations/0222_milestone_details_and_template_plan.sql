-- 0222_milestone_details_and_template_plan — A9: templates ("New project from a template") and the
-- project Milestones list + Edit milestone (Figma 376:17695 task 6: fq6-new-from-template,
-- fq6-milestones, fq6-edit-milestone).
--
-- ## What this migration is for
--
-- Edit milestone asks for two facts `project_milestones` (0048) cannot hold: **what is delivered**
-- (a short prose description) and an **owner** (the person answerable for it). Both are nullable,
-- so every existing milestone is valid unchanged. `owner_user_id` references `users (id)` like
-- `created_by_user_id`; the service checks the owner is an active member of the acting tenant
-- before it writes, so the foreign key is the backstop, not the tenant check.
--
-- "New project from a template" shows, per template, its milestone and work-item counts, whether the
-- client portal is on and whether it repeats — and copies milestones and work items into the new
-- project with dates moved to the chosen start date. `project_templates` (0106) held only a name, a
-- description and default objectives, so it gains the plan to copy:
--
--   * `milestones_json` — `[{ "title", "offsetDays", "description"?, "clientVisible"? }]`;
--   * `work_items_json` — `[{ "title", "offsetDays"? }]`;
--   * `client_portal_on` — whether a project made from it is shared with the chosen client;
--   * `repeat_interval` — `monthly` for a retainer, NULL for a one-off.
--
-- The arrays are validated and bounded in the application (the 0106 posture for
-- `default_objectives_json`).
--
-- ## MariaDB-safe
--
-- Plain `ADD COLUMN`s: no CHECK constraint, no generated column. `JSON` is the type 0106 already
-- uses on the live MariaDB host.

ALTER TABLE project_milestones
  ADD COLUMN description   TEXT     NULL AFTER title,
  ADD COLUMN owner_user_id CHAR(36) NULL AFTER description,
  ADD KEY ix_project_milestones_owner (owner_user_id),
  ADD CONSTRAINT fk_project_milestones_owner
    FOREIGN KEY (owner_user_id) REFERENCES users (id);

ALTER TABLE project_templates
  ADD COLUMN milestones_json  JSON              NULL AFTER default_objectives_json,
  ADD COLUMN work_items_json  JSON              NULL AFTER milestones_json,
  ADD COLUMN client_portal_on BOOLEAN           NOT NULL DEFAULT 0 AFTER work_items_json,
  ADD COLUMN repeat_interval  ENUM('monthly')   NULL AFTER client_portal_on;
