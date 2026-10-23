-- 0224_organization_logo — the organization's logo on the Organization settings card (A11).
--
-- The Organization card shows a logo orb (initials when none is set) with Upload logo / Remove. The
-- logo is an ordinary uploaded file: it travels the same reserve → parts → complete → verify → scan
-- pipeline as every other upload, under its own purpose `org_logo`, and the organization row keeps
-- only the id of the file asset that is the current logo.
--
-- `logo_file_id` is NULL when no logo is set (every organization before this migration). It is a
-- plain CHAR(36) with no foreign key: `file_assets` is keyed `(organization_id, id)` and this table's
-- tenant key is `id`, so a composite key would need a second organization column here. The route
-- checks the asset is this tenant's own `org_logo` file before it writes the id.
--
-- The two purpose ENUMs gain `org_logo` at the end, so every stored value keeps its position.
-- MariaDB-safe: plain ADD COLUMN and MODIFY COLUMN, no CHECK, no generated column.

ALTER TABLE organizations
  ADD COLUMN logo_file_id CHAR(36) NULL AFTER timezone;

ALTER TABLE file_assets
  MODIFY COLUMN purpose
    ENUM('message_attachment','request_attachment','deliverable','document','org_logo') NOT NULL;

ALTER TABLE upload_sessions
  MODIFY COLUMN purpose
    ENUM('message_attachment','request_attachment','deliverable','document','org_logo') NOT NULL;
