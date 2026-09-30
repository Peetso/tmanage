-- 0199_file_comments — file comments (x333, Files module).
--
-- Governing sources: 38-MODULE-MAP §Files & deliverables (collaboration — in-app discussion on a
-- file), 22-SCREEN §File detail (the comment thread), 23-ERD-AND-STATE-MACHINES §2 (tenant-scoped,
-- parent-owned records), 07-DATA-MODEL §9 (index prefixes lead with `organization_id`),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- The Files module stores file assets (0015) and, since x270, tags on them (0140) — but there was
-- no way to discuss a file in the app. This is that object at its smallest useful size: a member
-- leaves a comment on a file asset, the thread reads oldest-first, and a member may delete their own
-- comment. It is distinct from `document_comments` (0045, on documents) and from portal comments.
--
-- ## One tenant table, parent-owned
--
-- `file_comments` belongs to one org (`organization_id` scopes every row) and to one file asset
-- (`file_asset_id`). A composite foreign key binds `(organization_id, file_asset_id)` to
-- `file_assets (organization_id, id)`, so a cross-tenant file id is a non-existent pair rather than
-- a leak — the engine half of the trap the service also enforces: the service resolves the file
-- tenant-scoped BEFORE it authorizes or writes, so a cross-tenant id is a 404 with no insert.
--
-- `created_by` is the author's membership id (the acting `context.membershipId`, never a body
-- value), the `author_membership_id` posture `document_comments` takes; it is what the "delete own
-- comment only" rule is decided against in the service.
--
-- ## Immutable identity
--
-- `organization_id` is what a row *is*; moving it to another org is not an edit. The `BEFORE UPDATE`
-- trigger holds that at the engine, the way `file_tags` (0140) does. A comment is never amended in
-- place (the runtime credential is granted INSERT + DELETE only), so the trigger guards the one
-- column that must never move.

CREATE TABLE file_comments (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  file_asset_id    CHAR(36)     NOT NULL,
  body             TEXT         NOT NULL,
  -- The membership the comment was written under; the "delete own comment only" check compares it
  -- to the acting membership. Not a user id: authorship is per-membership, as on document comments.
  created_by       CHAR(36)     NOT NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_file_comments_org_id (organization_id, id),
  -- The index the thread is read by: this tenant's comments on one file, oldest-first
  -- (`created_at` then `id`), bounded.
  KEY ix_file_comments_file (organization_id, file_asset_id, created_at, id),
  -- A comment can only ever name a file asset of its own tenant.
  CONSTRAINT fk_file_comments_file
    FOREIGN KEY (organization_id, file_asset_id) REFERENCES file_assets (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A comment row's tenant is immutable, for the reason `file_tags`' trigger gives: moving it to
-- another org would change what it is, silently.
DELIMITER $$

CREATE TRIGGER trg_file_comments_immutable
BEFORE UPDATE ON file_comments FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'file_comments.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
