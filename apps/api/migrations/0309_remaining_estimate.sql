-- 0309_remaining_estimate — 53-08 workload hours (backend, part 2b), R21-b.
--
-- Governing source: 53-FEATURE-GAPS-PLANNING-COLLAB "53-08": a remaining estimate per work item that
-- defaults to the estimate and shrinks as time is logged; the planned load reads what is left, not the
-- original estimate.
--
-- Deviation (stated): the column sits on `work_item_estimates` (0128) as `remaining_minutes`, not on
-- `work_items` as `remaining_estimate_minutes`. The estimate and what is left of it belong together,
-- the 0128 `BEFORE UPDATE` trigger pins only `organization_id` / `work_item_id`, and `work_items` is
-- not touched.
--
-- NULL means "derived": the effective remaining is `max(0, estimate − logged)`, computed on read from
-- `work_item_time_logs` by one pure function (`effectiveRemaining`). A non-NULL value is a manual
-- override and wins, even when more has been logged than estimated. Nothing is decremented on write —
-- the time-log writers are unchanged.
--
-- MariaDB-safe (Hostinger): one plain ADD COLUMN — no generated column, no CHECK, no IF NOT EXISTS.
-- The bound (0 ≤ n ≤ estimate) is checked by the application.
-- Registry: no new table (schema.ts gains the column; the tenant guard already knows the table).
-- users.sql: UPDATE on `work_item_estimates` is already granted (the upsert); this slice adds
-- `GRANT DELETE ON person_allocations` for `DELETE …/projects/:projectId/allocations/:id`.

ALTER TABLE work_item_estimates
  ADD COLUMN remaining_minutes INT UNSIGNED NULL;
