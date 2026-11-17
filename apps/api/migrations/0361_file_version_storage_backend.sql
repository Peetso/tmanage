-- 0361_file_version_storage_backend — files can live in the company's Drive/OneDrive (57-13a).
--
-- `file_versions.storage_backend` says where a version's bytes are: `local` (TManage's object
-- store under `object_key`, every existing row) or `google_drive` / `onedrive`. A provider-held
-- version names the provider's own id (`provider_file_id`) and the `storage_connections` row that
-- holds it (`storage_connection_id`); both are written only by TManage (the 57-13b move job) and
-- read only by `files/provider-objects.ts` (VersionStore), never taken from a request. The closed
-- vocabulary is checked by the application. `object_key` stays as it is: the local key is the
-- record of where the bytes came from.
--
-- Not pinned by `trg_file_versions_immutable` (0019 pins its listed columns only), so the existing
-- UPDATE grant on `file_versions` covers the move; 57-13b decides whether to pin them once set.
--
-- MariaDB-safe (live is MariaDB 11.8): plain ADD COLUMN, a constant default, no ENUM, no
-- generated column, no CHECK, no IF NOT EXISTS. No new table: schema.ts columns only, tenant
-- guard unchanged, no new grant (users.sql carries a 0361 comment line).

ALTER TABLE file_versions
  ADD COLUMN storage_backend VARCHAR(16) NOT NULL DEFAULT 'local',
  ADD COLUMN provider_file_id VARCHAR(255) NULL,
  ADD COLUMN storage_connection_id CHAR(36) NULL;
