-- 0147_org_feature_flags — an org admin's per-org toggles for the optional modules, plus the
-- resolved flag set the current org read-side reads (module 18 Administration and governance, x278).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §3 (the optional/"later" modules an
-- org may turn on or off); 13-ENGINEERING-EXECUTION §feature gating; 22-SCREEN §Administration;
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys); 07-DATA-MODEL §9 (index
-- prefixes lead with organization_id).
--
-- ## Migration number
--
-- The pass-25 queue map reserves 0147 for x278. The highest migration present on this slice's base
-- (master 5b3fcf0) is 0115; 0116-0146 are reserved by sibling pass-24/25 branches not yet
-- integrated. The migrator applies files in ascending numeric order and a gap is not an error (it
-- rejects only a NEW file numbered below an applied one), so 0147 on top of 0115 is correct on this
-- base. If the integration renumbers the reservations, the integrator renumbers this file with them.
--
-- ## One row per (organization, flag_key)
--
-- A row is one optional-module flag's state in one studio, keyed `(organization_id, flag_key)` —
-- tenant-owned, registered in the query guard's TENANT_TABLES. `flag_key` is one of a fixed
-- allowlist of known optional-module keys validated by the application
-- (`feature-flags.controller.ts`): a key off the allowlist is a 400 and nothing is written, and an
-- unknown key on the read side resolves to its default (off) without a row. Absence of a row is
-- "default off", so "never set" and "explicitly disabled" read the same to the resolver — which is
-- the correct product behaviour for an optional module that has not been turned on.
--
-- ## The write is one upsert; identity is immutable
--
-- The repository writes `INSERT ... ON DUPLICATE KEY UPDATE` against `uq_org_feature_flags_org_key`,
-- so a second PUT for the same key updates in place and a lost update is not expressible. `enabled`
-- and `updated_by` (the acting membership, for the "who changed" the admin screen shows) move on
-- update; `updated_at` follows the column's `ON UPDATE`. `organization_id` and `flag_key` are what a
-- row is; the BEFORE UPDATE trigger pins them at the engine.

CREATE TABLE org_feature_flags (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The optional-module key this row toggles. One of a fixed application allowlist; a key off it is
  -- a 400 with no write. Bounded VARCHAR because the set is small, fixed, and human-readable.
  flag_key        VARCHAR(64)  NOT NULL,
  -- Whether the optional module is enabled for this studio. Absence of a row is the default (off),
  -- so this column only ever needs to record a deliberate state.
  enabled         TINYINT(1)   NOT NULL DEFAULT 0,
  -- The membership that last changed this flag (the "who" the admin screen shows). Nullable so a
  -- row can exist without attribution; the composite FK below binds it within this same tenant.
  updated_by      CHAR(36)     NULL,
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                               ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries.
  UNIQUE KEY uq_org_feature_flags_org_id (organization_id, id),
  -- One row per flag per studio. This is the upsert key: the repository writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place.
  UNIQUE KEY uq_org_feature_flags_org_key (organization_id, flag_key),
  CONSTRAINT fk_org_feature_flags_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The acting membership, bound within its own tenant: the composite key refuses a membership id
  -- from outside this row's organization, so attribution can never cite a membership in another
  -- studio.
  CONSTRAINT fk_org_feature_flags_updated_by_tenant
    FOREIGN KEY (organization_id, updated_by) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A row's tenant and flag key are what it is and are immutable; only `enabled`, `updated_by` and
-- `updated_at` change. The trigger holds identity at the engine, the reason every other identity
-- trigger in this schema exists.
DELIMITER $$

CREATE TRIGGER trg_org_feature_flags_immutable
BEFORE UPDATE ON org_feature_flags FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'org_feature_flags.organization_id is immutable';
  END IF;
  IF NEW.flag_key <> OLD.flag_key THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'org_feature_flags.flag_key is immutable';
  END IF;
END$$

DELIMITER ;
