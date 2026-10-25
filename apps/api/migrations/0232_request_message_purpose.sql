-- 0232_request_message_purpose — a file sent with a reply on a client request gets its own purpose.
--
-- Until now a reply file (A8, 0221) was uploaded as `request_attachment` with the request as its
-- `objectId`, the same purpose as a file on the request form, so the request's attachment list and
-- every purpose rule could not tell the two apart. From here a reply file is uploaded as
-- `request_message`: still bound to the request (`objectId` = the request, so the same request and
-- client-organization checks apply), still scanned and gated like every upload, and linked to its
-- message through `request_message_files`.
--
-- Old rows keep `request_attachment` and stay readable: the thread lists reply files through
-- `request_message_files`, whatever the asset's purpose.
--
-- The two purpose ENUMs gain `request_message` at the end, so every stored value keeps its position.
-- MariaDB-safe: plain MODIFY COLUMN, no CHECK, no generated column.

ALTER TABLE file_assets
  MODIFY COLUMN purpose
    ENUM('message_attachment','request_attachment','deliverable','document','org_logo','request_message') NOT NULL;

ALTER TABLE upload_sessions
  MODIFY COLUMN purpose
    ENUM('message_attachment','request_attachment','deliverable','document','org_logo','request_message') NOT NULL;
