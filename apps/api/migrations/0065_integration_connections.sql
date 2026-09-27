-- 0065_integration_connections — org-scoped app/integration connections (Automations module 17, x165).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Automations ("app directory" — a
-- catalog of integrations and the connections an org has made); 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX
-- §Automations; 07-DATA-MODEL §9 (index prefixes lead with `organization_id`); 25-AUTHORIZATION-AND-
-- TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## Migration number
--
-- Pass 21 reserves 0060–0080 in slice-id order; x165's reservation is 0065 (NEXT-SCOPES-13 header).
-- The highest migration on this slice's base (master bcfe397) is 0052; 0053–0064 are reserved by
-- sibling pass-21 branches not yet integrated, so 0065 sits above every reservation. The migrator
-- applies files in ascending numeric order and a gap is not an error (it rejects only a NEW file
-- numbered *below* an applied one), so 0065 on top of 0052 is correct on this base. If the
-- integration renumbers the reservations, the integrator renumbers this file with them; nothing here
-- depends on the literal 0065 beyond the filename.
--
-- ## What this migration is for
--
-- The Automations module has a static, code-defined catalog of apps a studio can connect to
-- (`catalog.service.ts`), but nothing records which ones an organization has *connected*. This is the
-- smallest useful unit that adds one — an **org-scoped connection**: which catalog app, a display
-- label, a status (`connected | pending`), and a bounded bag of **non-secret** settings.
--
-- ## No secrets, ever
--
-- Live OAuth to third parties is out of scope (Needs-Peter: external, paid). This slice records a
-- *connection intent* and non-secret configuration only. `config_json` is validated by the
-- application to reject secret-shaped keys (`token`, `secret`, `password`, `api_key`, …) before the
-- row is written, so a credential can never be persisted here. The column exists for settings such as
-- a workspace name or a default channel — never a token.
--
-- ## Org-scoped, not project-owned
--
-- Like `document_templates` (0039) and `work_forms` (0052), a connection belongs to the organization,
-- not a project: the tenant key is `organization_id` alone, bound to `organizations`. This slice
-- grants the app INSERT and SELECT only (no UPDATE, no DELETE): a connection is created and read, not
-- edited or removed by a runtime credential — an editor is a later slice with its own grant.
--
-- ## Identity is immutable
--
-- `organization_id`, `app_id` and `created_by` are what a connection *is*; the `BEFORE UPDATE` trigger
-- holds them at the engine, the reason every other identity trigger in this schema exists (ADR-0001
-- layers 3 and 4 are application-side and a direct SQL session bypasses both).

CREATE TABLE integration_connections (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The catalog app this connection is for. Validated against the code-defined catalog by the
  -- application (an off-catalog id is a 404 with no write); stored as a short opaque handle.
  app_id          VARCHAR(64)  NOT NULL,
  -- A short display label for the connection, like `work_forms.name` (VARCHAR(300)).
  label           VARCHAR(300) NOT NULL,
  -- `connected` or `pending`. Stored as VARCHAR and validated by the application, the same division
  -- the meeting/decision status columns use.
  status          VARCHAR(20)  NOT NULL,
  -- A bounded bag of NON-SECRET settings, validated whole by the application (secret-shaped keys are
  -- rejected before write). Read and written as a whole with the row, never queried across rows.
  config_json     JSON         NOT NULL,
  created_by      CHAR(36)     NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can reference
  -- this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_integration_connections_org_id (organization_id, id),
  -- The index a tenant's connections are listed by: this organization's connections in app then id
  -- order. Leads with `organization_id` per 07-DATA-MODEL §9.
  KEY ix_integration_connections_org_app (organization_id, app_id, id),
  CONSTRAINT fk_integration_connections_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The actor. References users (id) without organization_id because a user is not tenant-owned — the
  -- same shape `work_forms.created_by` (0052) uses.
  CONSTRAINT fk_integration_connections_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A connection's tenant, app and author are immutable, the reason `work_forms`' trigger gives.
-- `label`, `status` and `config_json` are left editable at the engine for a future editor slice;
-- identity is not.
DELIMITER $$

CREATE TRIGGER trg_integration_connections_immutable
BEFORE UPDATE ON integration_connections FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'integration_connections.organization_id is immutable';
  END IF;
  IF NEW.app_id <> OLD.app_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'integration_connections.app_id is immutable';
  END IF;
  IF NEW.created_by <> OLD.created_by THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'integration_connections.created_by is immutable';
  END IF;
END$$

DELIMITER ;
