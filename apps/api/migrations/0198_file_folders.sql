-- 0198_file_folders — file folders (x332, Files module).
--
-- Governing sources: 38-MODULE-MAP §Files & deliverables (organisation — the audit's "Files built;
-- no way to group them"), 22-SCREEN §Files (the folder tree + move control), 23-ERD-AND-STATE-
-- MACHINES §2 (tenant-scoped, parent-owned records), 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- The Files module stores file assets (0015) and now tags them (0140), but there was no way to
-- group a project's files into named folders. This is that grouping at its smallest useful size:
-- create a named folder inside a project, file an existing file asset into a folder (or back to
-- root), list a folder's contents, and delete an empty folder. It moves no bytes — a folder is an
-- organisational overlay, not storage.
--
-- ## One table, two row kinds
--
-- `file_folders` holds both halves in one table, distinguished by nullability (the x270/x294
-- pattern of `0140_file_tags.sql`):
--
--   * A **folder** row carries `project_id`, `name` and `created_by`, with `file_id`/`folder_id`
--     NULL. It is the named container. `(organization_id, project_id, name)` is unique
--     (`uq_file_folders_project_name`); the many NULL names on membership rows do not collide
--     because a UNIQUE index treats NULLs as distinct.
--   * A **membership** row carries `file_id` + `folder_id` (pointing at a folder row), with
--     `name`/`created_by`/`project_id` NULL. `(organization_id, file_id)` is unique
--     (`uq_file_folders_membership`) so a file is in at most one folder and re-filing is idempotent —
--     a repeated move is an UPDATE of `folder_id`, never a second row. Filing back to root deletes
--     the membership row.
--
-- ## Parent- and tenant-scoped
--
-- Everything belongs to one org. `organization_id` scopes every row. Three composite foreign keys
-- make a cross-tenant reference a non-existent pair rather than a leak: `fk_file_folders_project`
-- binds `(organization_id, project_id)` to `projects (organization_id, id)`,
-- `fk_file_folders_file` binds `(organization_id, file_id)` to `file_assets (organization_id, id)`,
-- and the self-referential `fk_file_folders_folder` binds `(organization_id, folder_id)` back to
-- this table's own `(organization_id, id)`. That is the engine half of the trap the service also
-- enforces in code: a cross-tenant project, file or folder id is a 404 with no write, never a row
-- against another tenant's file.
--
-- ## Identity is immutable
--
-- `organization_id` is what a row *is* — moving it to another org is not an edit. The
-- `BEFORE UPDATE` trigger holds that at the engine, the way `file_tags` (0140) does; ADR-0001
-- layers 3 and 4 are application-side and a direct SQL session bypasses both.

CREATE TABLE file_folders (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  -- Set on FOLDER rows (the project the folder lives in); NULL on MEMBERSHIP rows.
  project_id       CHAR(36)     NULL,
  -- Set on MEMBERSHIP rows (the filed file asset); NULL on FOLDER rows.
  file_id          CHAR(36)     NULL,
  -- Set on MEMBERSHIP rows (the folder row the file is filed into); NULL on FOLDER rows.
  folder_id        CHAR(36)     NULL,
  -- Set on FOLDER rows (the folder's display name, unique per project); NULL on MEMBERSHIP rows.
  name             VARCHAR(120) NULL,
  -- Set on FOLDER rows (the membership that created the folder); NULL on MEMBERSHIP rows.
  created_by       CHAR(36)     NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries; also the target of the
  -- self-referential folder foreign key below.
  UNIQUE KEY uq_file_folders_org_id (organization_id, id),
  -- A folder's name is unique per project. Membership rows carry a NULL name and a UNIQUE index
  -- treats NULLs as distinct, so they never collide here.
  UNIQUE KEY uq_file_folders_project_name (organization_id, project_id, name),
  -- A file is in at most one folder: one membership row per file. Folder rows carry a NULL file_id
  -- and so are exempt from this constraint; re-filing is an idempotent UPDATE of folder_id.
  UNIQUE KEY uq_file_folders_membership (organization_id, file_id),
  -- The index the folder tree is read by: this tenant's folder rows for one project.
  KEY ix_file_folders_project (organization_id, project_id, id),
  -- The index a folder's contents is read by: this tenant's membership rows for one folder.
  KEY ix_file_folders_folder (organization_id, folder_id, id),
  -- A folder can only ever live in a project of its own tenant.
  CONSTRAINT fk_file_folders_project
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  -- A membership can only ever name a file asset of its own tenant.
  CONSTRAINT fk_file_folders_file
    FOREIGN KEY (organization_id, file_id) REFERENCES file_assets (organization_id, id),
  -- A membership can only ever name a folder of its own tenant.
  CONSTRAINT fk_file_folders_folder
    FOREIGN KEY (organization_id, folder_id) REFERENCES file_folders (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A folder row's tenant is immutable, for the reason `file_tags`' trigger gives: moving it to
-- another org would change what it is, silently.
DELIMITER $$

CREATE TRIGGER trg_file_folders_immutable
BEFORE UPDATE ON file_folders FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'file_folders.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
