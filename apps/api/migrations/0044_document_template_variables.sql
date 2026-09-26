-- 0044_document_template_variables — a document template's declared variables (DOC-04, x130).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Docs and knowledge" (templates
-- with variables); 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX DOC-04 (template gallery/editor). NS-11
-- deferred DOC-04's variable half; this is the smallest useful unit that lands it.
--
-- ## Migration number
--
-- The highest migration after pass 19 is 0041, and pass 20 reserves 0042–0059 in id order; this
-- slice (x130) is assigned 0044. The integrator renumbers if the merge order differs.
--
-- ## What this migration is for
--
-- `document_templates` (0039) holds a name, a purpose and a reusable body. DOC-04's variable half
-- is the set of named placeholders a template *declares* — a key (the token a later slice will
-- substitute), a human label, a type (text/date/number) and whether it is required. This table
-- carries only what a template variable *is* at rest; substitution at render, defaults and the
-- docs client projection are deferred (NS-13).
--
-- ## Child of a template, scoped by tenant
--
-- A variable belongs to one template, which belongs to the organization (not a project). The tenant
-- key is `(organization_id, template_id)`, bound by a composite foreign key to
-- `document_templates (organization_id, id)` — the `(organization_id, id)` key 0039 carries — so a
-- variable can never reference a template in another tenant (ADR-0001 layer 1, 25-AUTH §6).
--
-- ## Keys are unique per template
--
-- `(organization_id, template_id, key)` is UNIQUE: a template cannot declare the same key twice, so
-- a duplicate is a 409 at the app and a constraint at the engine besides. It is also the index a
-- template's variables are listed by (this template's variables in key order), leading with
-- `organization_id` per 07-DATA-MODEL §9.
--
-- ## Identity is immutable; the app INSERTs and DELETEs, never UPDATEs
--
-- `organization_id` and `template_id` are what a variable is; the `BEFORE UPDATE` trigger holds
-- them at the engine, the reason every other trigger in this schema exists (ADR-0001 layers 3 and 4
-- are application-side and a direct SQL session bypasses both). This slice grants the app INSERT and
-- DELETE only (add and remove); there is no edit endpoint, so no UPDATE grant — an editor is a
-- later slice with its own grant.

CREATE TABLE document_template_variables (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- The template this variable is declared on. NOT NULL; the composite FK below binds it to the
  -- tenant so it can never reference a template in another organization.
  template_id        CHAR(36)     NOT NULL,
  -- The token a later slice substitutes, unique per template. `key` is a MySQL reserved word, so it
  -- is quoted here and everywhere it appears.
  `key`              VARCHAR(120) NOT NULL,
  -- The human label shown beside the field when a person fills the variable in.
  label              VARCHAR(300) NOT NULL,
  -- What kind of value the variable holds. Substitution/validation of the value is a later slice.
  type               ENUM('text', 'date', 'number') NOT NULL DEFAULT 'text',
  -- Whether a value must be supplied. Stored as TINYINT(1), the Drizzle `boolean` mirror.
  required           TINYINT(1)   NOT NULL DEFAULT 0,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_document_template_variables_org_id (organization_id, id),
  -- A template cannot declare the same key twice; also the list index (this template's variables in
  -- key order). Leads with `organization_id` per 07-DATA-MODEL §9.
  UNIQUE KEY uq_document_template_variables_org_template_key
    (organization_id, template_id, `key`),
  CONSTRAINT fk_document_template_variables_template_tenant
    FOREIGN KEY (organization_id, template_id)
    REFERENCES document_templates (organization_id, id),
  CONSTRAINT fk_document_template_variables_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A variable's tenant and template are immutable, the reason `document_templates`' trigger gives.
-- `key`, `label`, `type` and `required` are left editable at the engine for a future editor slice;
-- identity is not.
DELIMITER $$

CREATE TRIGGER trg_document_template_variables_immutable
BEFORE UPDATE ON document_template_variables FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'document_template_variables.organization_id is immutable';
  END IF;
  IF NEW.template_id <> OLD.template_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'document_template_variables.template_id is immutable';
  END IF;
END$$

DELIMITER ;
