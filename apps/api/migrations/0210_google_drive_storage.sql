-- 0210_google_drive_storage — Google Drive as a company's file storage (Peter-approved 2026-10-20).
--
-- Governing sources: walkthroughs-2026-10-18/GOOGLE-DRIVE-SETUP-FOR-PETER.md (OAuth client, the
-- `drive.file` scope only), MIC-FIGMA.md "Google Drive" (Control > Storage: TManage storage vs
-- Google Drive, connected / not configured / error states; "Attach from Google Drive" on New
-- work), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys) and 04-SECURITY-PRIVACY
-- (secrets encrypted at rest).
--
-- ## What this migration is for
--
-- An organization may keep its files in its own Google Drive instead of TManage's storage. Files
-- live in `TManage/<Project>/<Work item>/` under the chosen root (My Drive or a Shared Drive).
-- Three tables:
--
--   * `storage_connections` — one row per organization and provider: which storage the company
--     uses, the connected Google account's email, the Drive root folder, and the Google refresh
--     token **encrypted** (AES-256-GCM under the `AUTH_MFA_SEED_KEYS` keyring, the same envelope
--     the MFA seeds use, bound to the organization by the additional data). Never plaintext.
--   * `google_drive_folders` — the folder ids TManage created for a project or a work item under
--     one root, so a folder is created once and re-used.
--   * `google_drive_attachments` — a Drive file attached to a work item (picked or uploaded).
--     Detaching sets `removed_at`; the Drive file itself is never deleted by TManage.
--
-- ## Tenancy
--
-- All three are tenant-owned: `organization_id` scopes every row, each carries the
-- `(organization_id, id)` key, and they are registered in the guard's TENANT_TABLES. A work item
-- can only be attached to within its own tenant (composite foreign key). `organization_id` and the
-- identity columns are immutable (triggers below).
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns and keys only: no generated columns, no CHECK expressions, no expression defaults
-- beyond `CURRENT_TIMESTAMP(3)`, no JSON. Every key is within the 3072-byte InnoDB DYNAMIC limit.

CREATE TABLE storage_connections (
  id                    CHAR(36)      NOT NULL,
  organization_id       CHAR(36)      NOT NULL,
  -- `google_drive` (the only provider today).
  provider              VARCHAR(32)   NOT NULL,
  -- Which storage new files go to: `tmanage` (default) or `google_drive`.
  storage_mode          VARCHAR(32)   NOT NULL DEFAULT 'tmanage',
  -- `connected`, `error` (Google refused the token: expired or revoked) or `disconnected`.
  status                VARCHAR(32)   NOT NULL,
  -- The Google account that granted access; shown on the Storage screen.
  account_email         VARCHAR(320)  NULL,
  -- The refresh token, encrypted (`mfa1.<key version>.<iv>.<ciphertext>.<tag>`). NULL once
  -- disconnected: a disconnect wipes the secret rather than keeping it.
  refresh_token_enc     TEXT          NULL,
  -- The Drive folder id of `TManage/` under the chosen root.
  root_folder_id        VARCHAR(128)  NULL,
  -- The Shared Drive id and name when the root is a Shared Drive; NULL means My Drive.
  shared_drive_id       VARCHAR(128)  NULL,
  shared_drive_name     VARCHAR(190)  NULL,
  -- A short reason code for the `error` state (e.g. `revoked`); never Google's raw message.
  last_error_code       VARCHAR(64)   NULL,
  connected_by_user_id  CHAR(36)      NULL,
  connected_at          DATETIME(3)   NULL,
  disconnected_at       DATETIME(3)   NULL,
  updated_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at            DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_storage_connections_org_id (organization_id, id),
  -- One connection per provider per organization.
  UNIQUE KEY uq_storage_connections_provider (organization_id, provider),
  CONSTRAINT fk_storage_connections_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_storage_connections_user
    FOREIGN KEY (connected_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE google_drive_folders (
  id               CHAR(36)      NOT NULL,
  organization_id  CHAR(36)      NOT NULL,
  -- The `TManage/` folder this folder sits under; a new root means new folders.
  root_folder_id   VARCHAR(128)  NOT NULL,
  -- `project` or `work_item`.
  subject_kind     VARCHAR(16)   NOT NULL,
  -- The project or work item id.
  subject_id       CHAR(36)      NOT NULL,
  drive_folder_id  VARCHAR(128)  NOT NULL,
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_google_drive_folders_org_id (organization_id, id),
  UNIQUE KEY uq_google_drive_folders_subject (organization_id, root_folder_id, subject_kind, subject_id),
  CONSTRAINT fk_google_drive_folders_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE google_drive_attachments (
  id                   CHAR(36)      NOT NULL,
  organization_id      CHAR(36)      NOT NULL,
  work_item_id         CHAR(36)      NOT NULL,
  drive_file_id        VARCHAR(128)  NOT NULL,
  -- Display name and type as Drive reported them when attached.
  name                 VARCHAR(255)  NOT NULL,
  mime_type            VARCHAR(190)  NOT NULL,
  size_bytes           BIGINT        NULL,
  -- Drive's own "open in Drive" link (https://drive.google.com/...).
  web_view_link        VARCHAR(512)  NULL,
  attached_by_user_id  CHAR(36)      NOT NULL,
  -- Soft detach. The Drive file is never deleted by TManage.
  removed_at           DATETIME(3)   NULL,
  created_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_google_drive_attachments_org_id (organization_id, id),
  KEY ix_google_drive_attachments_item (organization_id, work_item_id, id),
  -- An attachment can only ever name a work item of its own tenant.
  CONSTRAINT fk_google_drive_attachments_item
    FOREIGN KEY (organization_id, work_item_id) REFERENCES work_items (organization_id, id),
  CONSTRAINT fk_google_drive_attachments_user
    FOREIGN KEY (attached_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_storage_connections_immutable
BEFORE UPDATE ON storage_connections FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.provider <> OLD.provider THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'storage_connections identity columns are immutable';
  END IF;
END$$

CREATE TRIGGER trg_google_drive_folders_immutable
BEFORE UPDATE ON google_drive_folders FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.subject_id <> OLD.subject_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'google_drive_folders identity columns are immutable';
  END IF;
END$$

CREATE TRIGGER trg_google_drive_attachments_immutable
BEFORE UPDATE ON google_drive_attachments FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.work_item_id <> OLD.work_item_id
     OR NEW.drive_file_id <> OLD.drive_file_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'google_drive_attachments identity columns are immutable';
  END IF;
END$$

DELIMITER ;
