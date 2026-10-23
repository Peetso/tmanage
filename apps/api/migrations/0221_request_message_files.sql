-- 0221_request_message_files — files attached to a message on a client request (A8, fq9 portal reply).
--
-- The portal's reply card has "Attach file": a client uploads through the portal upload session
-- (purpose `request_attachment`, `objectId` = the request, so the file is already bound to that
-- request and to the client's organization), then names the uploaded file ids on the message it
-- posts. This table is the join between the message and those files; the team view lists them.
--
-- ## Tenant-scoped at both ends
--
-- Composite foreign keys bind `(organization_id, message_id)` to `request_messages` and
-- `(organization_id, file_asset_id)` to `file_assets`, so a cross-tenant message or file id is a
-- non-existent pair rather than a leak. The service additionally checks that the file belongs to
-- the same request (and, for a client, to the client's own organization) before it inserts.
--
-- ## Append-only (INSERT + SELECT)
--
-- A message is never edited, so neither is what was attached to it: the runtime credential is
-- granted INSERT only (`scripts/db/users.sql`) and the `BEFORE UPDATE` trigger refuses any
-- amendment for every other credential. MariaDB-safe: plain columns, keys, a trigger; no CHECK
-- constraint and no generated column.

CREATE TABLE request_message_files (
  id                        CHAR(36)    NOT NULL,
  organization_id           CHAR(36)    NOT NULL,
  message_id                CHAR(36)    NOT NULL,
  -- Denormalised from the message so the thread read is one index range per request.
  request_id                CHAR(36)    NOT NULL,
  file_asset_id             CHAR(36)    NOT NULL,
  attached_by_membership_id CHAR(36)    NOT NULL,
  created_at                DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_request_message_files_org_id (organization_id, id),
  -- A file is attached to one message at most once.
  UNIQUE KEY uq_request_message_files_edge (organization_id, message_id, file_asset_id),
  -- The thread read: this tenant's attachments for one request.
  KEY ix_request_message_files_request (organization_id, request_id, created_at, id),
  KEY ix_request_message_files_file (organization_id, file_asset_id),
  CONSTRAINT fk_request_message_files_message
    FOREIGN KEY (organization_id, message_id) REFERENCES request_messages (organization_id, id),
  CONSTRAINT fk_request_message_files_file_asset
    FOREIGN KEY (organization_id, file_asset_id) REFERENCES file_assets (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_request_message_files_immutable
BEFORE UPDATE ON request_message_files FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'request_message_files rows are append-only';
END$$

DELIMITER ;
