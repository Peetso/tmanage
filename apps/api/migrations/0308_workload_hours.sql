-- 0308_workload_hours — 53-08 workload hours and capacity (backend, part 1), R20-b.
--
-- Governing source: 53-FEATURE-GAPS-PLANNING-COLLAB "53-08". A people allocation (0069) gains:
--   `status`          — `tentative` | `confirmed` (default `confirmed`, so every existing row keeps
--                       counting toward planned hours exactly as before). A tentative allocation is
--                       shown apart from planned hours until a project manager confirms it
--                       (`POST …/allocations/:id/confirm`).
--   `hours_per_week`  — an explicit weekly figure; NULL means "use `percent` of the member's
--                       weekly capacity" (the 0069 meaning).
--   `note`            — a short free-text note (≤ 300 characters).
--
-- MariaDB-safe (Hostinger): plain ADD COLUMN only — VARCHAR instead of ENUM, no CHECK, no generated
-- column, no IF NOT EXISTS. The closed `status` vocabulary and the `hours_per_week` bound
-- (0 < n ≤ 168) are checked by the application.
-- Registry: no new table (schema.ts columns only; the tenant guard already knows the table).
-- users.sql gains `GRANT UPDATE ON person_allocations` (confirm is the app's first UPDATE there).

ALTER TABLE person_allocations
  ADD COLUMN status VARCHAR(10) NOT NULL DEFAULT 'confirmed',
  ADD COLUMN hours_per_week DECIMAL(5,2) NULL,
  ADD COLUMN note VARCHAR(300) NULL;
