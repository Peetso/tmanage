-- 0346_work_item_cloud_folders — a live Google Drive or OneDrive folder on a work item (FIX6 C3).
--
-- A member attaches one of the company drive's folders to a work item. TManage keeps only which
-- folder it is (the provider's ids and the name at attach time) and who attached it; the folder's
-- children are read live from the provider with the company connection every time they are
-- listed. A client sees the folder in the portal only on a client-visible work item, and every
-- child they open is checked on the server to be inside the attached folder.
--
-- Removing the attachment sets `removed_at`; a removed row is never listed or opened again (the
-- row stays as evidence of who attached what). The drive itself is never written.
--
-- TENANT: keyed `(organization_id, id)`.
--
-- MariaDB-safe (live is MariaDB 11.8): plain columns, DATETIME(3), no generated columns, no CHECK,
-- no functional or partial indexes, utf8mb4_unicode_ci. Additive only: one new table.

CREATE TABLE work_item_cloud_folders (
  id                        CHAR(36)       NOT NULL,
  organization_id           CHAR(36)       NOT NULL,
  project_id                CHAR(36)       NOT NULL,
  work_item_id              CHAR(36)       NOT NULL,
  provider                  VARCHAR(16)    NOT NULL,
  external_drive_id         VARCHAR(255)   NULL,
  external_folder_id        VARCHAR(255)   NOT NULL,
  name                      VARCHAR(255)   NOT NULL,
  attached_by_user_id       CHAR(36)       NOT NULL,
  created_at                DATETIME(3)    NOT NULL,
  removed_at                DATETIME(3)    NULL,
  removed_by_user_id        CHAR(36)       NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_work_item_cloud_folders_org_id (organization_id, id),
  KEY ix_work_item_cloud_folders_item (organization_id, work_item_id, removed_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
