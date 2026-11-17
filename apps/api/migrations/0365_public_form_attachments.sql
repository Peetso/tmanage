-- 0365_public_form_attachments — the public-form attachment rule (52-20a, FORMATTACH).
--
-- A visitor on a published public form (`/f/<slug>`, 52-20) may attach files only when the form's
-- owner allows it. The owner's setting is `work_forms.attachment_project_id`: NULL (the default)
-- means no attachments; a project id means visitors may attach images (JPG, PNG, WebP, HEIC) and
-- PDF, up to 25 MB each and 5 per submission, and the files are kept in that project. The upload
-- service checks type, size, quota and the scan exactly as for every other upload; a file from a
-- stranger is never downloadable before a clean scan.
--
-- The new upload purpose `form_attachment` names the submission the file belongs to in
-- `object_id`. The two purpose ENUMs gain it at the end, so every stored value keeps its position
-- (as 0224, 0232, 0292 and 0362).
--
-- MariaDB-safe (live is MariaDB 11.8): ALTER ... MODIFY of an ENUM and one plain nullable column;
-- no generated column, no CHECK, no IF NOT EXISTS, no foreign key (the service resolves the project
-- tenant-scoped when the owner sets it and again on every upload). No new table: schema.ts only,
-- tenant guard unchanged, no new grant (users.sql carries a 0365 comment line).

ALTER TABLE file_assets
  MODIFY COLUMN purpose
    ENUM('message_attachment','request_attachment','deliverable','document','org_logo','request_message','expense_receipt','client_upload','form_attachment') NOT NULL;

ALTER TABLE upload_sessions
  MODIFY COLUMN purpose
    ENUM('message_attachment','request_attachment','deliverable','document','org_logo','request_message','expense_receipt','client_upload','form_attachment') NOT NULL;

ALTER TABLE work_forms
  ADD COLUMN attachment_project_id CHAR(36) NULL AFTER published_at;
