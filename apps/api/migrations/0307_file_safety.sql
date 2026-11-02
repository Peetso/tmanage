-- 0307_file_safety — 56-06 file safety (backend), R19-e.
--
-- Governing source: 56-SECURITY-AND-TRUST-PLAN "56-06" (one shared `file-safety` module; honest
-- "scanned by" chip facts). A file version now records WHO judged its bytes:
--   `tmanage`  — a real verdict from this deployment's engine (clamav),
--   `provider` — reserved for an object held in a provider store (Drive/OneDrive): no driver
--                writes it today,
--   `none`     — nothing scanned it (the `none`/`stub` drivers, or no verdict yet).
-- NULL on rows written before 0307 is read as the resolver's answer
-- (`apps/api/src/modules/files/file-safety.ts` `resolveScanSource`), so no backfill is needed.
--
-- The 0019 trigger `trg_file_versions_immutable` pins the listed columns only; `scan_source` is
-- written beside the verdict by the same UPDATE (`FileAssetsRepository.recordScan`).
--
-- MariaDB-safe (Hostinger): one plain ADD COLUMN — no ENUM, no generated column, no CHECK, no
-- IF NOT EXISTS. The closed vocabulary is checked by the application.
-- Registry: no new table (schema.ts column only; tenant guard unchanged; the UPDATE grant on
-- `file_versions` already exists — users.sql carries a 0307 comment line). The file-safety
-- settings are `org_settings` key/value rows (`file_safety_presets`, `require_scan_for_clients`).

ALTER TABLE file_versions
  ADD COLUMN scan_source VARCHAR(8) NULL;
