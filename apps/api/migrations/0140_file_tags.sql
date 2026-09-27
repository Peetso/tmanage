-- 0140_file_tags — file tags (x270, Files module).
--
-- Governing sources: 38-MODULE-MAP §Files (govern/find versions; upload-center organisation — the
-- audit's "Files built; no tag taxonomy to find them by"), 23-ERD-AND-STATE-MACHINES §2 (tenant-
-- scoped, parent-owned records), 07-DATA-MODEL §9 (index prefixes lead with `organization_id`),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- The Files module stores file assets (0015) and their versions (0018), but there was no tag
-- taxonomy: no way to define a reusable org label and hang it on a file so the upload centre can
-- list files by tag. This is that object at its smallest useful size — define a named tag once per
-- org, then tag / untag file assets with it.
--
-- ## One table, two row kinds
--
-- `file_tags` holds both halves in one table, distinguished by nullability (the x233 pattern of
-- `0105_work_item_labels.sql`):
--
--   * A **definition** row carries `name`, with `file_id` and `tag_id` NULL. It is the reusable tag.
--     `name` is unique per tenant (`uq_file_tags_org_name`); the many NULL names on assignment rows
--     do not collide because a UNIQUE index treats NULLs as distinct.
--   * An **assignment** row carries `file_id` + `tag_id` (pointing at a definition row), with `name`
--     NULL. `(organization_id, tag_id, file_id)` is unique so tagging is idempotent — a second
--     identical assign is a no-op, not a duplicate.
--
-- ## Parent- and tenant-scoped
--
-- Everything belongs to one org. `organization_id` scopes every row. Two composite foreign keys
-- make a cross-tenant reference a non-existent pair rather than a leak: `fk_file_tags_file`
-- binds `(organization_id, file_id)` to `file_assets (organization_id, id)`, and the
-- self-referential `fk_file_tags_tag` binds `(organization_id, tag_id)` to this table's own
-- `(organization_id, id)`. That is the engine half of the trap the service also enforces in code: a
-- cross-tenant file or tag id is a 404 with no write, never a row against another tenant's file.
--
-- ## Identity is immutable
--
-- `organization_id` is what a row *is* — moving it to another org is not an edit. The
-- `BEFORE UPDATE` trigger holds that at the engine, the way `work_item_labels` (0105) does;
-- ADR-0001 layers 3 and 4 are application-side and a direct SQL session bypasses both.

CREATE TABLE file_tags (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  -- Set on ASSIGNMENT rows (the tagged file asset); NULL on DEFINITION rows.
  file_id          CHAR(36)     NULL,
  -- Set on ASSIGNMENT rows (the definition row this points at); NULL on DEFINITION rows.
  tag_id           CHAR(36)     NULL,
  -- Set on DEFINITION rows (the tag's display name, unique per tenant); NULL on ASSIGNMENT rows.
  name             VARCHAR(120) NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries; also the target of the
  -- self-referential tag foreign key below.
  UNIQUE KEY uq_file_tags_org_id (organization_id, id),
  -- A tag's name is unique per org. Assignment rows carry a NULL name and a UNIQUE index treats
  -- NULLs as distinct, so they never collide here.
  UNIQUE KEY uq_file_tags_org_name (organization_id, name),
  -- Tagging is idempotent: one (tag, file) pair once. Definition rows carry NULLs in both columns
  -- and so are exempt from this constraint.
  UNIQUE KEY uq_file_tags_assignment (organization_id, tag_id, file_id),
  -- The index the file's chips are read by: this tenant's assignment rows for one file.
  KEY ix_file_tags_file (organization_id, file_id, id),
  -- The index the upload-centre filter is read by: this tenant's assignment rows for one tag.
  KEY ix_file_tags_tag (organization_id, tag_id, id),
  -- An assignment can only ever name a file asset of its own tenant.
  CONSTRAINT fk_file_tags_file
    FOREIGN KEY (organization_id, file_id) REFERENCES file_assets (organization_id, id),
  -- An assignment can only ever name a tag definition of its own tenant.
  CONSTRAINT fk_file_tags_tag
    FOREIGN KEY (organization_id, tag_id) REFERENCES file_tags (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A tag row's tenant is immutable, for the reason `work_item_labels`' trigger gives: moving it to
-- another org would change what it is, silently.
DELIMITER $$

CREATE TRIGGER trg_file_tags_immutable
BEFORE UPDATE ON file_tags FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'file_tags.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
