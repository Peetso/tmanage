-- 0173_automation_variables — org-scoped, non-secret automation variables a workflow template may
-- reference (Automations & integrations, module 17, x305; complements x162's workflow_templates 0063,
-- x190's workflow_conditions 0081, x163's runs).
--
-- Governing sources: 22-SCREEN-INVENTORY §AUT (automations); 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP
-- §Automations & integrations; 24-EVENT-CATALOG (workflows); 07-DATA-MODEL §9 (index prefixes lead
-- with `organization_id`); 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## Migration number
--
-- Pass 25 reserves 0145–0173 in slice-id order; x305's reservation is 0173 (pass25-queue header map).
-- The migrator applies files in ascending numeric order and a gap is not an error (it rejects only a
-- NEW file numbered *below* an applied one), so 0173 on this base is correct.
--
-- ## What this migration is for
--
-- A workflow template references configuration by name (a channel, a threshold, a label). This adds
-- the smallest useful store for that: an org-level `(var_key -> var_value)` map. It is deliberately
-- **non-secret only** — credentials/secrets are a separate Needs-Peter secret store — so the
-- application refuses a key whose name looks secret-like (`password`/`token`/`secret`/`key`) and holds
-- `var_key` to a safe identifier grammar before any write.
--
-- ## Org-scoped, one row per key
--
-- A variable belongs to the organization and is addressed by `var_key` within it. `uq_..._org_key` is
-- the upsert key: `PUT` writes `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save of a
-- key updates its value in place. `updated_at` carries `ON UPDATE CURRENT_TIMESTAMP(3)` so the engine
-- moves it whenever the value changes; `updated_by` is moved by the application on the update path.
--
-- ## Identity is immutable
--
-- `organization_id` and `var_key` are what a variable *is*; the `BEFORE UPDATE` trigger holds them at
-- the engine (ADR-0001 layers 3 and 4 are application-side and a direct SQL session bypasses both),
-- the reason every other identity trigger in this schema exists. The app is granted
-- INSERT/UPDATE/DELETE (upsert and remove) — never a schema change — so the trigger is the
-- engine-level backstop that keeps an upsert from re-keying a row.

CREATE TABLE automation_variables (
  id              CHAR(36)      NOT NULL,
  organization_id CHAR(36)      NOT NULL,
  -- The variable's name, unique within the tenant. A safe identifier the application validates
  -- (`^[a-zA-Z][a-zA-Z0-9_]{0,63}$`) and refuses when secret-like, before any write.
  var_key         VARCHAR(64)   NOT NULL,
  -- The variable's value. A non-secret string the application size-checks before the write.
  var_value       VARCHAR(2000) NOT NULL,
  -- The person who last wrote the variable. Set by the application on both insert and update paths.
  updated_by      CHAR(36)      NOT NULL,
  updated_at      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries (the isolation corpus requires it).
  UNIQUE KEY uq_automation_variables_org_id (organization_id, id),
  -- One row per key per studio. This is the upsert key: the repository writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place.
  UNIQUE KEY uq_automation_variables_org_key (organization_id, var_key),
  CONSTRAINT fk_automation_variables_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The actor. References users (id) without organization_id because a user is not tenant-owned —
  -- the same shape `workflow_conditions.created_by` (0081) uses.
  CONSTRAINT fk_automation_variables_updated_by
    FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A variable's tenant and key are what it is and are immutable; only the value, author and updated_at
-- change. The trigger holds identity at the engine — in particular it stops an upsert from silently
-- re-keying a row — the reason every other identity trigger in this schema exists.
DELIMITER $$

CREATE TRIGGER trg_automation_variables_immutable
BEFORE UPDATE ON automation_variables FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'automation_variables.organization_id is immutable';
  END IF;
  IF NEW.var_key <> OLD.var_key THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'automation_variables.var_key is immutable';
  END IF;
END$$

DELIMITER ;
