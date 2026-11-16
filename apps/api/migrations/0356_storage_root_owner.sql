-- 0356_storage_root_owner — 51-17 company-owned storage root: owner kind and hand-over.
--
-- ## What this migration is for
--
-- A company's files live in whichever Google or Microsoft account an admin connected. When that
-- person leaves, a root in their personal drive goes with them. `storage_connections` (0210)
-- gains three columns:
--
-- - `root_owner_kind` — who owns the place the `TManage/` root sits in: `shared_drive` (a Google
--   Shared Drive), `sharepoint_library` (a SharePoint / OneDrive-for-Business document library),
--   `personal` (My Drive, or one person's OneDrive) or `unknown` (not detected yet). Closed list
--   checked in the API. The Storage screen recommends a company-owned root when it is `personal`.
-- - `handover_to_user_id` — the admin an owner asked to take the connection over; that admin's
--   own consent completes it. NULL when no hand-over is pending.
-- - `handed_over_at` — when the connection last changed hands (the audit log keeps who to whom).
--
-- Backfill: Google rows with a Shared Drive are `shared_drive`, other Google rows `personal`.
-- OneDrive rows stay `unknown` until their location is saved again (the drive type is not kept).
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- VARCHAR instead of ENUM, constant default, no generated column, no CHECK, no index, no
-- IF NOT EXISTS, DATETIME(3). Additive only: old code ignores the columns. Grants are table-level
-- (scripts/db/users.sql already grants the app INSERT, UPDATE on `storage_connections`).
-- Registry: schema.ts (`storageConnections`); the table is already in TABLES and tenant-guard.

ALTER TABLE storage_connections
  ADD COLUMN root_owner_kind VARCHAR(20) NOT NULL DEFAULT 'unknown',
  ADD COLUMN handover_to_user_id CHAR(36) NULL,
  ADD COLUMN handed_over_at DATETIME(3) NULL;

UPDATE storage_connections
  SET root_owner_kind = CASE WHEN shared_drive_id IS NULL THEN 'personal' ELSE 'shared_drive' END
  WHERE provider = 'google_drive';
