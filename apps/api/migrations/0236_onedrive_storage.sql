-- 0236_onedrive_storage — Microsoft OneDrive as a company's file storage, a second option next to
-- Google Drive (0210). Plan: wave-2026-10-26/onedrive/PLAN.md.
--
-- ## What this migration is for
--
-- An organization may keep its files in its own OneDrive (personal Microsoft account, work or
-- school account, or a SharePoint document library) instead of TManage's storage. Files live in
-- `TManage/<Project>/<Work item>/` under the chosen root. Microsoft Graph addresses an item by
-- (drive id, item id), so every OneDrive row carries both.
--
--   * `storage_connections` (0210) gains three NULL columns: the Graph drive id and label of the
--     chosen root's drive, and which scopes the grant holds. The OneDrive connection is its own
--     row (`provider = 'onedrive'`; `uq_storage_connections_provider` already allows one row per
--     provider). Google rows leave the new columns NULL. The refresh token is stored exactly as
--     Google's is: AES-256-GCM under `AUTH_MFA_SEED_KEYS`, bound to the organization.
--   * `onedrive_folders` — the folder items TManage created for a project or a work item under one
--     root, so a folder is created once and re-used.
--   * `onedrive_attachments` — a OneDrive file attached to a work item (picked or uploaded).
--     Detaching sets `removed_at`; the OneDrive file itself is never deleted by TManage.
--
-- ## Tenancy
--
-- Both new tables are tenant-owned: `organization_id` scopes every row, each carries the
-- `(organization_id, id)` key, and they are registered in the guard's TENANT_TABLES. An
-- attachment can only name a work item of its own tenant (composite foreign key).
-- `organization_id` and the identity columns are immutable (triggers below).
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns and keys only: no generated columns, no CHECK expressions, no expression defaults
-- beyond `CURRENT_TIMESTAMP(3)`, no JSON. Every key is within the 3072-byte InnoDB DYNAMIC limit
-- (the widest, `uq_onedrive_folders_subject`, is 144 + 1020 + 64 + 144 = 1372 bytes).
-- Additive only: old code ignores the three columns and never reads the two tables.

ALTER TABLE storage_connections
  ADD COLUMN onedrive_drive_id   VARCHAR(128) NULL,
  ADD COLUMN onedrive_drive_name VARCHAR(190) NULL,
  ADD COLUMN granted_scopes      VARCHAR(512) NULL;

CREATE TABLE onedrive_folders (
  id               CHAR(36)      NOT NULL,
  organization_id  CHAR(36)      NOT NULL,
  -- The Graph drive the folder lives in.
  drive_id         VARCHAR(128)  NOT NULL,
  -- The `TManage/` folder item this folder sits under; a new root means new folders.
  root_item_id     VARCHAR(255)  NOT NULL,
  -- `project` or `work_item`.
  subject_kind     VARCHAR(16)   NOT NULL,
  -- The project or work item id.
  subject_id       CHAR(36)      NOT NULL,
  item_id          VARCHAR(255)  NOT NULL,
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_onedrive_folders_org_id (organization_id, id),
  UNIQUE KEY uq_onedrive_folders_subject (organization_id, root_item_id, subject_kind, subject_id),
  CONSTRAINT fk_onedrive_folders_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE onedrive_attachments (
  id                   CHAR(36)      NOT NULL,
  organization_id      CHAR(36)      NOT NULL,
  work_item_id         CHAR(36)      NOT NULL,
  drive_id             VARCHAR(128)  NOT NULL,
  item_id              VARCHAR(255)  NOT NULL,
  -- Display name and type as Graph reported them when attached.
  name                 VARCHAR(255)  NOT NULL,
  mime_type            VARCHAR(190)  NOT NULL,
  size_bytes           BIGINT        NULL,
  -- OneDrive's own "open" link (onedrive.live.com, 1drv.ms or *.sharepoint.com, https only).
  web_url              VARCHAR(512)  NULL,
  attached_by_user_id  CHAR(36)      NOT NULL,
  -- Soft detach. The OneDrive file is never deleted by TManage.
  removed_at           DATETIME(3)   NULL,
  created_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_onedrive_attachments_org_id (organization_id, id),
  KEY ix_onedrive_attachments_item (organization_id, work_item_id, id),
  -- An attachment can only ever name a work item of its own tenant.
  CONSTRAINT fk_onedrive_attachments_item
    FOREIGN KEY (organization_id, work_item_id) REFERENCES work_items (organization_id, id),
  CONSTRAINT fk_onedrive_attachments_user
    FOREIGN KEY (attached_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_onedrive_folders_immutable
BEFORE UPDATE ON onedrive_folders FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.subject_id <> OLD.subject_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'onedrive_folders identity columns are immutable';
  END IF;
END$$

CREATE TRIGGER trg_onedrive_attachments_immutable
BEFORE UPDATE ON onedrive_attachments FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.work_item_id <> OLD.work_item_id
     OR NEW.item_id <> OLD.item_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'onedrive_attachments identity columns are immutable';
  END IF;
END$$

DELIMITER ;
