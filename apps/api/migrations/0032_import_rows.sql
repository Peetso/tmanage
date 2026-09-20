-- 0032_import_rows — the per-row receipt for an onboarding-import commit (ON-09 commit half,
-- ADM-10 "receipt").
--
-- Governing sources: 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §Onboarding ON-09 ("Import/migration
-- — source mapping, validation, progress, partial failure") and §Admin ADM-10 ("Data
-- import/export — scope, validation, progress, receipt"); 07-DATA-MODEL §9 (every composite
-- index begins with organization_id); migration 0028 (`import_jobs`, the parent this child
-- references) is the nearest precedent for the tenant-table shape.
--
-- ## What this migration does
--
-- The x95 slice landed the validate / dry-run half: `import_jobs` records the attempt and its
-- counts and creates NO target entity. This slice is the commit half — it takes a previously
-- validated job, re-validates the batch, and **creates the target entities** (projects today,
-- the first source kind x95's validators cover), each row passing the object-layer
-- `project.create` authorize so a commit is no broader than a manual create. Two schema changes
-- support that:
--
--   1. `import_rows` (new) — one row per source row in a commit, the durable per-row receipt:
--      what happened to source index N, and the id of the entity it created (or the error that
--      stopped it). This is ADM-10's "receipt" at row granularity, and ON-09's "partial failure"
--      made auditable: valid rows carry `outcome = 'created'` with `created_entity_id`, invalid
--      or refused rows carry `outcome = 'failed'` with `error_detail`, in the same job.
--
--   2. `import_jobs` (altered) — the terminal transition of a committed job. `status` reuses the
--      existing VARCHAR(32) for the new terminal values (`committed` | `committed_with_errors`);
--      0028's own comment reserved exactly this ("a later slice's new status ('committed', …) is
--      then a value the code adds, not a column-type migration"). `committed_at`, `committed_count`
--      and `failed_count` are the receipt summary — NULL until the commit half transitions the job,
--      which is what keeps a validate-only job distinguishable from a committed one.
--
-- ## outcome is VARCHAR, not ENUM
--
-- Same reasoning as 0028's `status` and `source_kind`: `outcome` carries a closed vocabulary the
-- application owns (`created` | `failed`). VARCHAR(32) so a later outcome (e.g. `skipped`) is a
-- value the code adds, not a column-type migration. The TypeScript union is the enforced
-- vocabulary; the column is storage.
--
-- ## Tenant scope and the composite foreign key
--
-- `(organization_id, id)` is unique so a future child could reference a receipt row without a
-- cross-tenant path, and the parent reference is the composite `(organization_id, job_id)` ->
-- `import_jobs (organization_id, id)`, which binds a receipt to a job **of the same tenant** —
-- a row can never cite another organization's job. `(organization_id, job_id, source_index)` is
-- unique so a commit records each source index exactly once, and leads with `organization_id`
-- for the tenant predicate and the receipt-in-order read. Forward-only, applied exactly once by
-- the ledger like its siblings.

CREATE TABLE import_rows (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- The parent import_jobs row, bound to the same tenant by the composite FK below.
  job_id             CHAR(36)     NOT NULL,
  -- The zero-based index of the source row in the committed batch (ON-09's "progress").
  source_index       INT UNSIGNED NOT NULL,
  -- 'created' | 'failed' — the per-row outcome (partial failure is explicit and recorded).
  outcome            VARCHAR(32)  NOT NULL,
  -- The id of the entity this row created, or NULL for a failed row. No composite FK to
  -- projects: the created kind widens over time (work items next), so the reference is a
  -- recorded id rather than a typed foreign key, the way audit_events.object_id is.
  created_entity_id  CHAR(36)     NULL,
  -- The validation/authorization error that stopped a failed row, or NULL for a created row.
  error_detail       VARCHAR(500) NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries.
  UNIQUE KEY uq_import_rows_org_id (organization_id, id),
  -- Each source index is recorded exactly once per job, and this leads the tenant predicate
  -- for the ordered per-job receipt read.
  UNIQUE KEY uq_import_rows_job_source (organization_id, job_id, source_index),
  -- Binds a receipt to a job of the SAME tenant: the reference is composite, so a receipt can
  -- never cite another organization's job.
  CONSTRAINT fk_import_rows_job
    FOREIGN KEY (organization_id, job_id) REFERENCES import_jobs (organization_id, id),
  CONSTRAINT fk_import_rows_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The terminal transition of a committed job. `status` already holds the vocabulary (0028);
-- these three columns are the receipt summary, NULL until the commit half transitions the job.
ALTER TABLE `import_jobs`
  ADD COLUMN `committed_at`    DATETIME(3)  NULL AFTER `created_at`,
  ADD COLUMN `committed_count` INT UNSIGNED NULL AFTER `committed_at`,
  ADD COLUMN `failed_count`    INT UNSIGNED NULL AFTER `committed_count`;
