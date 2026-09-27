-- 0148_audit_retention_policy — an organization's audit-log retention window: the number of days it
-- keeps its `audit_events` before a later, separately-credentialed purge would remove them
-- (Administration module 18, audit retention, x279).
--
-- Governing sources: 04-SECURITY-PRIVACY §retention (an org sets how long it keeps its audit trail);
-- 33-LEGAL-AND-COMPLIANCE (retention is a compliance control, set per organization); 38-MODULE-MAP
-- §Administration audit; 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys); 07-DATA-MODEL
-- §9 (index prefixes lead with organization_id). Distinct from the audit read/export slices: those read
-- `audit_events`; this stores the policy and previews how many rows fall outside the window.
--
-- ## Migration number
--
-- The pass-25 queue map reserves 0148 for x279. The migrator applies files in ascending numeric order
-- and a gap is not an error (it rejects only a NEW file numbered below an already-applied one), so 0148
-- on top of the base's highest applied migration is correct. If the integration renumbers the
-- reservations, the integrator renumbers this file with them.
--
-- ## One row per organization; preview only, no purge here
--
-- A row is one organization's retention policy, keyed `(organization_id, id)` — tenant-owned like
-- `security_settings` (0073) and `org_settings` (0058), registered in the query guard's TENANT_TABLES.
-- `uq_audit_retention_policy_org` makes it one row per organization: the repository writes
-- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place and a lost update
-- is not expressible. `retention_days` is bounded 1..3650 by the application before any write — an
-- out-of-range value is a 400 and nothing is stored (the column is unsigned, so the engine refuses a
-- negative besides). The GET reads this policy and then a read-only COUNT of the existing
-- `audit_events` older than `now - retention_days`, tenant-scoped; nothing here writes, deletes, or
-- amends `audit_events` — the actual purge is a later, separately-credentialed procedure, exactly as
-- `scripts/db/users.sql` describes for that append-only table.
--
-- ## The write is one upsert; identity is immutable
--
-- `organization_id` is what a row is; the BEFORE UPDATE trigger pins it at the engine, the reason every
-- other identity trigger in this schema exists. Only `retention_days`, `updated_by` and `updated_at`
-- move on an upsert. This slice grants the app INSERT and UPDATE (the upsert), no DELETE.

CREATE TABLE audit_retention_policy (
  id                CHAR(36)     NOT NULL,
  organization_id   CHAR(36)     NOT NULL,
  -- The retention window in whole days. Bounded 1..3650 by the application before any write; unsigned
  -- so the engine refuses a negative even if the check were bypassed.
  retention_days    INT UNSIGNED NOT NULL,
  -- The global user id that last set the policy. Not tenant-owned — the same shape
  -- `security_settings.updated_by` (0073) uses for its actor; the FK below binds it to a real user.
  updated_by        CHAR(36)     NOT NULL,
  updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                 ON UPDATE CURRENT_TIMESTAMP(3),
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, the target of the composite FKs
  -- that bind child rows within one tenant (and the isolation corpus requires it).
  UNIQUE KEY uq_audit_retention_policy_org_id (organization_id, id),
  -- One row per organization. This is the upsert key: the repository writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place.
  UNIQUE KEY uq_audit_retention_policy_org (organization_id),
  CONSTRAINT fk_audit_retention_policy_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_audit_retention_policy_updated_by
    FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A row's tenant is what it is and is immutable; only the window, actor and updated_at change. The
-- trigger holds identity at the engine, the reason every other identity trigger in this schema exists.
DELIMITER $$

CREATE TRIGGER trg_audit_retention_policy_immutable
BEFORE UPDATE ON audit_retention_policy FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'audit_retention_policy.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
