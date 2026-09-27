-- 0137_project_tags — project tags / labels (x267, Projects / portfolio module).
--
-- Governing sources: 38-MODULE-MAP §Projects/portfolio (portfolio filtering/direction — tag a
-- project with an org-defined label and filter the portfolio by tag), 23-ERD-AND-STATE-MACHINES §2
-- (tenant-scoped, parent-owned records), 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- The Projects module stores projects and their objectives (0040), updates (0041), milestones
-- (0048) and risks (0049), but there was no way to hang an org-defined label on a project and filter
-- the portfolio by it. `work_item_labels` (0105, x233) is the same shape but scoped to work items;
-- this is the project-scoped sibling at its smallest useful size — define a named tag once per
-- studio, then tag / untag projects with it.
--
-- ## One table, two row kinds
--
-- `project_tags` holds both halves in one table, distinguished by nullability, the x233 pattern:
--
--   * A **definition** row carries `name`, with `project_id` and `tag_id` NULL. It is the reusable
--     tag. `name` is unique per tenant (`uq_project_tags_org_name`); the many NULL names on
--     assignment rows do not collide because a UNIQUE index treats NULLs as distinct.
--   * An **assignment** row carries `project_id` + `tag_id` (pointing at a definition row), with
--     `name` NULL. `(organization_id, tag_id, project_id)` is unique so tagging is idempotent — a
--     second identical assign is a no-op, not a duplicate.
--
-- ## Parent- and tenant-scoped
--
-- Everything belongs to one studio. `organization_id` scopes every row. Two composite foreign keys
-- make a cross-tenant reference a non-existent pair rather than a leak: `fk_project_tags_project`
-- binds `(organization_id, project_id)` to `projects (organization_id, id)`, and the
-- self-referential `fk_project_tags_tag` binds `(organization_id, tag_id)` to this table's own
-- `(organization_id, id)`. That is the engine half of the trap the service also enforces in code: a
-- cross-tenant project or tag id is a 404 with no write, never a row against someone else's project.
--
-- ## Identity is immutable
--
-- `organization_id` is what a row *is* — moving it to another studio is not an edit. The
-- `BEFORE UPDATE` trigger holds that at the engine, the way `work_item_labels` (0105) does; ADR-0001
-- layers 3 and 4 are application-side and a direct SQL session bypasses both.

CREATE TABLE project_tags (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  -- Set on ASSIGNMENT rows (the tagged project); NULL on DEFINITION rows.
  project_id       CHAR(36)     NULL,
  -- Set on ASSIGNMENT rows (the definition row this points at); NULL on DEFINITION rows.
  tag_id           CHAR(36)     NULL,
  -- Set on DEFINITION rows (the tag's display name, unique per tenant); NULL on ASSIGNMENT rows.
  name             VARCHAR(120) NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries; also the target of the
  -- self-referential tag foreign key below.
  UNIQUE KEY uq_project_tags_org_id (organization_id, id),
  -- A tag's name is unique per studio. Assignment rows carry a NULL name and a UNIQUE index
  -- treats NULLs as distinct, so they never collide here.
  UNIQUE KEY uq_project_tags_org_name (organization_id, name),
  -- Tagging is idempotent: one (tag, project) pair once. Definition rows carry NULLs in both
  -- columns and so are exempt from this constraint.
  UNIQUE KEY uq_project_tags_assignment (organization_id, tag_id, project_id),
  -- The index a project's chips are read by: this tenant's assignment rows for one project.
  KEY ix_project_tags_project (organization_id, project_id, id),
  -- An assignment can only ever name a project of its own tenant.
  CONSTRAINT fk_project_tags_project
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  -- An assignment can only ever name a tag definition of its own tenant.
  CONSTRAINT fk_project_tags_tag
    FOREIGN KEY (organization_id, tag_id) REFERENCES project_tags (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A tag row's tenant is immutable, for the reason `work_item_labels`' trigger gives: moving it to
-- another studio would change what it is, silently.
DELIMITER $$

CREATE TRIGGER trg_project_tags_immutable
BEFORE UPDATE ON project_tags FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_tags.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
