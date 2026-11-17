-- 0362_client_upload_purpose — clients upload files in the portal (55-14a, PORTALUPLOAD).
--
-- A client adds a file to one of their own projects from the portal's Files page. Until now a
-- client could upload only a request attachment or a reply file, both bound to a request row. The
-- new upload purpose `client_upload` is a project file a client sent: bound to the project and to
-- the uploader's client organization (`file_assets.client_organization_id`), `objectId` NULL,
-- client-visible audience. The upload service checks project scope, type, size, quota, the daily
-- allowance and the scan exactly as for every other client upload.
--
-- The two purpose ENUMs gain it at the end, so every stored value keeps its position (as 0224,
-- 0232 and 0292). MariaDB-safe (live is MariaDB 11.8): ALTER ... MODIFY of an ENUM, no generated
-- column, no CHECK, no IF NOT EXISTS. No new table: schema.ts `UPLOAD_PURPOSES` only, tenant
-- guard unchanged, no new grant (users.sql carries a 0362 comment line).

ALTER TABLE file_assets
  MODIFY COLUMN purpose
    ENUM('message_attachment','request_attachment','deliverable','document','org_logo','request_message','expense_receipt','client_upload') NOT NULL;

ALTER TABLE upload_sessions
  MODIFY COLUMN purpose
    ENUM('message_attachment','request_attachment','deliverable','document','org_logo','request_message','expense_receipt','client_upload') NOT NULL;
