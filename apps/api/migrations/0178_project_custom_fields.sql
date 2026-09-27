-- 0178_project_custom_fields — an organization's custom fields for projects: define a field
-- (name, key, type, options) and set a value per project; read the resolved field+value map for
-- one project (PROJ / module 8, 38-MODULE-MAP §Projects & portfolio "custom metadata", 22-SCREEN
-- §Project detail, x310).
--
-- Governing sources: 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC §5-6 (scoped writes, composite
-- tenant keys); 07-DATA-MODEL §9 (every composite index prefix begins with organization_id);
-- ADR-0001 (MySQL has no row-level security; the application layers replace it and the withheld
-- privilege is a control).
--
-- ## Migration number
--
-- The pass-26 queue map reserves 0178 for x310. The migrator applies files in ascending numeric
-- order and a gap is not an error (it rejects only a NEW file numbered below an applied one), so
-- 0178 on this base is correct. If the integration renumbers the reservations, the integrator
-- renumbers this file with them.
--
-- ## One table, two row kinds (the x294/x306 precedent)
--
-- A field *definition* and a per-project *value* are the same shape of small tenant-owned record, so
-- they share one table with a `row_kind` discriminator rather than two tables and two migrations:
--
--   * a `definition` row is the fact "this organization defines a project field `field_key`, shown as
--     `name`, of `field_type`, with these `options_json`". It has no project, so `project_id` is the
--     empty sentinel `''` (see the unique key below) and `value_text` is NULL.
--   * a `value` row is the fact "project `project_id` has `value_text` for field `field_key`". It
--     carries a real `project_id` and `value_text`; `name`, `field_type` and `options_json` are the
--     definition's, so they are NULL here.
--
-- ## Uniqueness with one index
--
-- The brief asks for two rules — a definition is unique per `(org, field_key)`, a value is unique per
-- `(org, project_id, field_key)`. One unique key `(organization_id, project_id, field_key)` expresses
-- both: definitions all carry `project_id = ''`, so `(org, '', field_key)` collapses to one definition
-- per key; values carry a real project id, so `(org, project_id, field_key)` is one value per field
-- per project. A definition and a value for the same key never collide because their `project_id`
-- differs. The sentinel is `''`, never NULL, precisely so the unique key enforces the definition rule
-- (MySQL treats NULLs as distinct, which would let duplicate definitions through). It is the upsert
-- key too: `PUT` a value writes `INSERT ... ON DUPLICATE KEY UPDATE value_text`, so re-setting a field
-- moves the value in place rather than creating a second row.
--
-- ## A value's project is not an FK — the service resolves it (the inbox_snoozes posture)
--
-- `project_id` carries `''` for definitions, which is not a project id, so a composite foreign key to
-- `projects (organization_id, id)` cannot cover this column. The tenant safety for a value's project is
-- therefore the same as `inbox_snoozes` (0129): the service resolves the project under an
-- `organization_id = context` predicate BEFORE it authorizes or writes, so a value can never be set
-- against a project in another studio, and an unknown or cross-tenant id is a 404 with no row — never a
-- foreign-key 500. The organization foreign key still binds every row to the acting tenant.

CREATE TABLE project_custom_fields (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  -- Which kind of record this row is. A `definition` declares a field for the whole organization; a
  -- `value` is one project's value for a field. The reads filter on it, and the immutability trigger
  -- pins it — a row never changes kind.
  row_kind         ENUM('definition','value') NOT NULL,
  -- The project a `value` row is set on. For a `definition` it is the empty sentinel `''` (never a
  -- project, never NULL) so the unique key below enforces one definition per key. No foreign key: the
  -- service resolves the project tenant-scoped before the write (the inbox_snoozes posture).
  project_id       CHAR(36)     NOT NULL DEFAULT '',
  -- The stable key a field is addressed by in the API path and the value map, e.g. `client_tier`.
  -- Non-empty, bounded by the app. Shared by a definition and every value that references it.
  field_key        VARCHAR(120) NOT NULL,
  -- A definition's human label ("Client tier"). NULL on a `value` row — a value takes its label from
  -- the definition. Non-empty on a definition, bounded by the app.
  name             VARCHAR(200) NULL,
  -- A definition's value type. `select` constrains a value to one of `options_json`. NULL on a value.
  field_type       ENUM('text','number','select') NULL,
  -- A `select` definition's allowed options, as a JSON array of strings. NULL for `text`/`number`
  -- definitions and for value rows.
  options_json     JSON         NULL,
  -- A value's payload, stored as text (a number is the number's text, a select is one of the options).
  -- NULL on a definition row.
  value_text       TEXT         NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can reference
  -- this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_project_custom_fields_org_id (organization_id, id),
  -- Both uniqueness rules in one key (see the header): definitions carry `project_id = ''` so this is
  -- one definition per `(org, field_key)`; values carry a real project so it is one value per
  -- `(org, project_id, field_key)`. Leads with organization_id per 07-DATA-MODEL §9, and is the upsert
  -- key for `PUT` a value.
  UNIQUE KEY uq_project_custom_fields_scope (organization_id, project_id, field_key),
  -- 07-DATA-MODEL §9: the two reads that exist — the org's definitions (row_kind='definition'), and one
  -- project's values (row_kind='value', project_id=...). Leads with organization_id.
  KEY ix_project_custom_fields_org_kind_project (organization_id, row_kind, project_id, field_key),
  CONSTRAINT fk_project_custom_fields_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A row's tenant, kind, project and key are what it is and are immutable; only a value's `value_text`
-- (and `updated_at`) change, and only on a `value` row. The trigger pins identity at the engine, the
-- reason every other identity trigger in this schema exists (ADR-0001 layers 3 and 4 are
-- application-side and a direct SQL session bypasses both).
DELIMITER $$

CREATE TRIGGER trg_project_custom_fields_immutable
BEFORE UPDATE ON project_custom_fields FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_custom_fields.organization_id is immutable';
  END IF;
  IF NEW.row_kind <> OLD.row_kind THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_custom_fields.row_kind is immutable';
  END IF;
  IF NEW.project_id <> OLD.project_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_custom_fields.project_id is immutable';
  END IF;
  IF NEW.field_key <> OLD.field_key THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_custom_fields.field_key is immutable';
  END IF;
END$$

DELIMITER ;
