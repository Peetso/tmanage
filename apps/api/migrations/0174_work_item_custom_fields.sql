-- 0174_work_item_custom_fields — org-defined custom fields on work items (x306, Work module).
--
-- Governing sources: 38-MODULE-MAP §Work management (custom metadata — the audit's "Work built; no
-- custom field taxonomy"), 22-SCREEN §Work item detail, 23-ERD-AND-STATE-MACHINES §2 (tenant-scoped,
-- parent-owned records), 07-DATA-MODEL §9 (index prefixes lead with `organization_id`),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- The Work module stores work items and their checklist (0051), comments (0053), forms (0052) and
-- labels (0105), but there was no custom-field taxonomy: no way for a studio to define a reusable
-- field (a text/number/select attribute) and set its value per work item. This is that object at its
-- smallest useful size — define a field once per studio, then set a value for it on a work item, and
-- read the resolved field+value map for an item.
--
-- ## One table, two row kinds (x294 precedent)
--
-- `work_item_custom_fields` holds both halves in one table, distinguished by `row_kind` and
-- nullability, so a value references a definition without a second table:
--
--   * A **definition** row (`row_kind = 'definition'`) carries `definition_key` (the field's stable
--     key, unique per tenant), `name`, `field_type` (`text`/`number`/`select`) and, for a select,
--     `options` (a JSON array of allowed strings). `work_item_id`, `value_key` and `value_text` are
--     NULL. `definition_key` is unique per tenant (`uq_work_item_custom_fields_definition`); the many
--     NULL `definition_key`s on value rows do not collide because a UNIQUE index treats NULLs as
--     distinct.
--   * A **value** row (`row_kind = 'value'`) carries `work_item_id`, `value_key` (the key of the
--     definition it sets) and `value_text` (the stored value, always as text — a number is stored as
--     its decimal string). `definition_key`, `name`, `field_type` and `options` are NULL.
--     `(organization_id, work_item_id, value_key)` is unique so setting a value is an idempotent
--     upsert — a second set of the same field on the same item revises in place, never a duplicate.
--
-- ## Parent- and tenant-scoped
--
-- Everything belongs to one studio. `organization_id` scopes every row. The composite foreign key
-- `fk_work_item_custom_fields_work_item` binds `(organization_id, work_item_id)` to
-- `work_items (organization_id, id)`, so a value can only ever name a work item of its own tenant — a
-- cross-tenant `work_item_id` does not exist as a pair even when both ids exist individually. That is
-- the engine half of the trap the service also enforces in code: a cross-tenant parent is a 404 with
-- no write, never a value stored against someone else's work.
--
-- ## Identity is immutable
--
-- `organization_id` is what a row *is* — moving it to another studio is not an edit. The
-- `BEFORE UPDATE` trigger holds that at the engine, the way `work_item_labels` (0105) does; ADR-0001
-- layers 3 and 4 are application-side and a direct SQL session bypasses both. A value's `value_text`
-- (and its `updated_at`) is edited in place through the upsert; nothing else on a row changes.

CREATE TABLE work_item_custom_fields (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  -- Which half this row is. `definition` rows carry the field's shape; `value` rows carry one item's
  -- value for a field. The service reads and writes each kind explicitly.
  row_kind         ENUM('definition', 'value') NOT NULL,
  -- Set on DEFINITION rows (the field's stable key, unique per tenant); NULL on VALUE rows.
  definition_key   VARCHAR(80)  NULL,
  -- Set on DEFINITION rows (the field's display name); NULL on VALUE rows.
  name             VARCHAR(160) NULL,
  -- Set on DEFINITION rows (`text` | `number` | `select`); NULL on VALUE rows.
  field_type       ENUM('text', 'number', 'select') NULL,
  -- Set on DEFINITION rows of type `select` (a JSON array of the allowed option strings); NULL
  -- otherwise. The service bounds the count and each option's length before write.
  options          JSON         NULL,
  -- Set on VALUE rows (the tagged work item); NULL on DEFINITION rows.
  work_item_id     CHAR(36)     NULL,
  -- Set on VALUE rows (the key of the definition this value is for); NULL on DEFINITION rows.
  value_key        VARCHAR(80)  NULL,
  -- Set on VALUE rows (the stored value, always as text — a number is its decimal string); NULL on
  -- DEFINITION rows.
  value_text       TEXT         NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_work_item_custom_fields_org_id (organization_id, id),
  -- A field definition's key is unique per studio. Value rows carry a NULL `definition_key` and a
  -- UNIQUE index treats NULLs as distinct, so they never collide here.
  UNIQUE KEY uq_work_item_custom_fields_definition (organization_id, definition_key),
  -- Setting a value is idempotent: one (work item, field key) pair once. Definition rows carry NULLs
  -- in both columns and so are exempt from this constraint.
  UNIQUE KEY uq_work_item_custom_fields_value (organization_id, work_item_id, value_key),
  -- The index an item's field values are read by: this tenant's value rows for one work item.
  KEY ix_work_item_custom_fields_item (organization_id, work_item_id, id),
  -- A value can only ever name a work item of its own tenant; the composite key is what makes a
  -- cross-tenant `work_item_id` a non-existent pair rather than a leak.
  CONSTRAINT fk_work_item_custom_fields_work_item
    FOREIGN KEY (organization_id, work_item_id) REFERENCES work_items (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A custom-field row's tenant is immutable, for the reason `work_item_labels`' trigger gives: moving
-- it to another studio would change what it is, silently.
DELIMITER $$

CREATE TRIGGER trg_work_item_custom_fields_immutable
BEFORE UPDATE ON work_item_custom_fields FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_custom_fields.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
