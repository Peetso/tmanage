-- 0243_organization_lifecycle_limits — an organization can be soft-deleted and restored, and the
-- platform operator can override its plan limits and billing mode.
--
-- ## What this migration is for
--
-- Platform admin v2 (SPEC §6, slice PA-07). Nothing hard-deletes from the UI (SPEC P7):
--
-- 1. `organizations` gains the soft-delete trail — `deleted_at`, `purge_after` (now + the
--    platform's `retention.org_purge_days`, 30 by default), `deleted_by_user_id` — plus a per-org
--    `billing_mode_override` ('beta_free' | 'paid', NULL = follow the platform) and the operator's
--    internal `operator_notes` (never shown to the organization). The membership resolver refuses
--    a deleted organization with `organization_closed` (PA-01 probes for `deleted_at`); restore
--    clears the three columns; the worker's organization purge hands an organization past
--    `purge_after` to the privacy erasure path (0231/0233).
-- 2. `organization_limits` — one optional row per organization with explicit people / active
--    project / storage limits. NULL in a column means "the plan's value"; `entitlementsFor()`
--    merges the row over the plan (the override wins).
--
-- Users columns (disabled_at, two-step reset) are PA-06's 0247, not here.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain nullable columns with no default expression, one ordinary index, one new table with
-- literal defaults and `CURRENT_TIMESTAMP(3)`, VARCHAR vocabulary (no ENUM), no CHECK, no
-- generated column, utf8mb4_unicode_ci. Additive only: old code ignores every column.

ALTER TABLE organizations
  ADD COLUMN deleted_at DATETIME(3) NULL AFTER suspended_at,
  ADD COLUMN purge_after DATETIME(3) NULL AFTER deleted_at,
  ADD COLUMN deleted_by_user_id CHAR(36) NULL AFTER purge_after,
  ADD COLUMN billing_mode_override VARCHAR(16) NULL AFTER deleted_by_user_id,
  ADD COLUMN operator_notes TEXT NULL AFTER billing_mode_override,
  ADD KEY ix_organizations_deleted (deleted_at, purge_after);

CREATE TABLE organization_limits (
  id                     CHAR(36)    NOT NULL,
  organization_id        CHAR(36)    NOT NULL,
  people_limit           INT         NULL,
  active_projects_limit  INT         NULL,
  storage_bytes_limit    BIGINT      NULL,
  updated_by             CHAR(36)    NULL,
  created_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_org_limits_org (organization_id),
  UNIQUE KEY uq_org_limits_org_id (organization_id, id),
  CONSTRAINT fk_org_limits_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_org_limits_updated_by
    FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
