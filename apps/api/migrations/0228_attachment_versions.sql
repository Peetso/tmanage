-- 0228_attachment_versions — version history for plain attachments (lane C7, audit gap 12,
-- WRK-05 / A6). Until now only a deliverable's file had versions (`deliverable_versions`, 0211).
--
-- A plain attachment (a work item's file, a request's file, a document's file) keeps its first
-- upload as version 1: the file asset itself, the one the work item, request or document already
-- links to. Every later upload is its own `file_assets` row — uploaded, verified and scanned by the
-- same pipeline — and one row here says "this asset is version N of that root asset". Downloads of
-- any version go through the existing download route by the version's own file asset id, so the
-- owner's scan policy (`block` / `allow_labeled`) applies to a previous version exactly as to the
-- current one.
--
-- Append-only: INSERT + SELECT for the app credential and a BEFORE UPDATE trigger, the posture of
-- `request_message_files` (0221). No DELETE: the history is the record of how the file changed.
-- Plain CREATE TABLE with composite foreign keys that include `organization_id`; no CHECK and no
-- generated column, because the live host is MariaDB.

CREATE TABLE attachment_versions (
  id                  CHAR(36)      NOT NULL,
  organization_id     CHAR(36)      NOT NULL,
  project_id          CHAR(36)      NOT NULL,
  -- Version 1: the asset the work item, request or document links to.
  root_file_asset_id  CHAR(36)      NOT NULL,
  -- This version's own asset (2, 3 …).
  file_asset_id       CHAR(36)      NOT NULL,
  version_no          INT UNSIGNED  NOT NULL,
  note                VARCHAR(2000) NULL,
  created_by_user_id  CHAR(36)      NOT NULL,
  created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_attachment_versions_org_id (organization_id, id),
  -- Two concurrent uploads cannot both become version N: the loser collides and retries.
  UNIQUE KEY uq_attachment_versions_org_root_no (organization_id, root_file_asset_id, version_no),
  -- An asset is a version of one attachment at most once.
  UNIQUE KEY uq_attachment_versions_org_file (organization_id, file_asset_id),
  CONSTRAINT fk_attachment_versions_root
    FOREIGN KEY (organization_id, root_file_asset_id) REFERENCES file_assets (organization_id, id),
  CONSTRAINT fk_attachment_versions_file
    FOREIGN KEY (organization_id, file_asset_id) REFERENCES file_assets (organization_id, id),
  CONSTRAINT fk_attachment_versions_project
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_attachment_versions_immutable
BEFORE UPDATE ON attachment_versions FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'attachment_versions rows are append-only';
END$$

DELIMITER ;
