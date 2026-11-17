-- 0367_storage_migration_job_total_bytes — the size a "Move to Drive" job set out to move (57-13 follow-up).
--
-- `storage_migration_jobs.total_bytes` is the sum of `file_versions.size_bytes` over the versions
-- the job counted in `total` when it was started, so the storage card reads "1.1 of 3.4 GB" next
-- to "312 of 1,240 files". Written once by the API on INSERT (the existing grant); never taken from
-- a request. It cannot be worked out later: the candidate set shrinks as files move.
--
-- MariaDB-safe (live is MariaDB 11.8): plain ADD COLUMN with a constant default, no generated
-- column, no CHECK, no IF NOT EXISTS. No new table: schema.ts column only, tenant guard unchanged,
-- no new grant (users.sql carries a 0367 comment line).

ALTER TABLE storage_migration_jobs
  ADD COLUMN total_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0;
