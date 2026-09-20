-- 0028_import_jobs — the onboarding-import attempt anchor (ON-09, validate / dry-run half).
--
-- Governing sources: 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §Onboarding ON-09 ("Import/migration
-- — source mapping, validation, progress, partial failure") and §Admin ADM-10 ("Data
-- import/export — scope, validation, progress, receipt"); 07-DATA-MODEL §9 (every composite
-- index begins with organization_id) and the house tenant-table shape (migration 0021
-- usage_ledger_entries is the nearest CREATE TABLE precedent).
--
-- ## What this table is
--
-- One row per import validation attempt. This slice runs the dry-run half: it validates a batch
-- of source rows against a mapping, records the outcome here, and creates NO target entity. The
-- row is the durable anchor ON-09's "progress" and ADM-10's "receipt" read from — who ran the
-- attempt, the source kind, the outcome, and the counts. The commit half (creating projects /
-- work from a validated attempt) is a separate slice; it will add its own columns and an
-- `import_rows` child rather than reshape this table.
--
-- ## status and source_kind are VARCHAR, not ENUM
--
-- Both carry a closed vocabulary the application owns (`ImportValidationStatus` and
-- `IMPORT_SOURCE_KINDS` in import-validation.ts). VARCHAR(32) rather than ENUM for the reason
-- 0021's `reason` column gives: a later slice's new status ('committed', 'partially_committed')
-- or a second source kind is then a value the code adds, not a column-type migration. The
-- TypeScript unions are the enforced vocabulary; the column is storage.
--
-- ## Counts
--
-- total = valid + invalid, all INT UNSIGNED (a count is never negative). They are the report's
-- own numbers, written once; this half never updates a row after it is inserted.
--
-- ## Tenant scope and re-runnability
--
-- `(organization_id, id)` is unique so a future child (`import_rows`) can reference a job with a
-- composite foreign key that binds to the same tenant, never a cross-tenant path — the same
-- arrangement every scoped table here carries. Forward-only, applied exactly once by the ledger
-- like its siblings; the migrator never re-executes an applied file.

CREATE TABLE import_jobs (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  created_by_user_id CHAR(36)     NOT NULL,
  -- One of IMPORT_SOURCE_KINDS (import-validation.ts). 'project' today; a new kind is a value.
  source_kind        VARCHAR(32)  NOT NULL,
  -- 'validated' | 'validated_with_errors' — the dry-run outcome (partial failure is explicit).
  status             VARCHAR(32)  NOT NULL,
  total_count        INT UNSIGNED NOT NULL,
  valid_count        INT UNSIGNED NOT NULL,
  invalid_count      INT UNSIGNED NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_import_jobs_org_id (organization_id, id),
  -- Leads the tenant predicate and orders an organization's attempts newest-last for the
  -- progress/receipt list.
  KEY ix_import_jobs_org_created (organization_id, created_at),
  CONSTRAINT fk_import_jobs_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The actor. References users (id) without organization_id because a user is not tenant-owned
  -- — the same shape projects.owner_user_id uses (fk_projects_owner).
  CONSTRAINT fk_import_jobs_creator
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
