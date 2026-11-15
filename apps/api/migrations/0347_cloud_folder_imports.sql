-- 0347_cloud_folder_imports — the checked copy of a file opened from a live drive folder (FIX6 C3b).
--
-- A file a member or a client opens from a folder attached to a work item (0346) is not streamed
-- raw: the server fetches it once with the company connection and stores it as a checked TManage
-- copy through the upload's own path (file safety, quota, verifier, scanner, previews), then
-- serves it with the normal viewer. This table remembers which copy belongs to which drive item
-- and version, so the same unchanged file is imported once per project:
-- keyed `(organization_id, project_id, provider, external_item_id, modified_time)`; a file
-- changed in the drive (a new modified time) becomes a new copy.
--
-- `cloud_folder_id` is the folder the copy was opened through. A client reaches the copy only
-- while that folder is still attached to a client-visible work item.
--
-- TENANT: keyed `(organization_id, id)`.
--
-- MariaDB-safe (live is MariaDB 11.8): plain columns, DATETIME(3), no generated columns, no CHECK,
-- no functional or partial indexes, utf8mb4_unicode_ci. The unique key is 1532 bytes (< 3072,
-- DYNAMIC rows). Additive only: one new table.

CREATE TABLE cloud_folder_imports (
  id                        CHAR(36)       NOT NULL,
  organization_id           CHAR(36)       NOT NULL,
  project_id                CHAR(36)       NOT NULL,
  cloud_folder_id           CHAR(36)       NOT NULL,
  provider                  VARCHAR(16)    NOT NULL,
  external_item_id          VARCHAR(255)   NOT NULL,
  modified_time             VARCHAR(40)    NOT NULL,
  file_asset_id             CHAR(36)       NOT NULL,
  created_at                DATETIME(3)    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cloud_folder_imports_org_id (organization_id, id),
  UNIQUE KEY uq_cloud_folder_imports_item (organization_id, project_id, provider, external_item_id, modified_time),
  KEY ix_cloud_folder_imports_asset (organization_id, file_asset_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
