-- 0238_storage_location_name — the name of the folder a company picked for its Drive storage.
--
-- ## What this migration is for
--
-- The Storage screen showed `TManage/` whatever the company had chosen, because only the id of
-- the `TManage/` root was kept, not where it sits. `storage_connections` (0210) gains one NULL
-- column: the display name of the place the root was created in — the picked folder's name, or
-- `My Drive` when the company chose the top of its Drive. The screen then reads
-- `<location>/TManage/`. OneDrive rows already keep that name in `onedrive_drive_name` (0236) and
-- leave this column NULL. Rows written before this migration stay NULL, and the screen falls back
-- to `TManage/` for them until the location is chosen again.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- One plain nullable column, no default expression, no index. Additive only: old code ignores it.

ALTER TABLE storage_connections
  ADD COLUMN location_name VARCHAR(190) NULL;
