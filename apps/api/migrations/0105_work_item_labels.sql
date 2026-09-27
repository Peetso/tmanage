-- 0105_work_item_labels — work item labels / tags (x233, Work module 7).
--
-- Governing sources: 38-MODULE-MAP §Work management (label/tag taxonomy — the audit's "Work built;
-- no label/tag taxonomy"), 23-ERD-AND-STATE-MACHINES §2 (tenant-scoped, parent-owned records),
-- 07-DATA-MODEL §9 (index prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- The Work module stores work items and their checklist (0051), comments (0053) and forms (0052),
-- but there was no label/tag taxonomy: no way to define a reusable label and hang it on an item.
-- This is that object at its smallest useful size — define a named, coloured label once per studio,
-- then tag / untag work items with it.
--
-- ## One table, two row kinds
--
-- `work_item_labels` holds both halves in one table, distinguished by nullability:
--
--   * A **definition** row carries `name` + `color`, with `work_item_id` and `label_id` NULL. It is
--     the reusable label. `name` is unique per tenant (`uq_work_item_labels_org_name`); the many
--     NULL names on assignment rows do not collide because a UNIQUE index treats NULLs as distinct.
--   * An **assignment** row carries `work_item_id` + `label_id` (pointing at a definition row), with
--     `name` + `color` NULL. `(organization_id, work_item_id, label_id)` is unique so tagging is
--     idempotent — a second identical assign is a no-op, not a duplicate.
--
-- ## Parent- and tenant-scoped
--
-- Everything belongs to one studio. `organization_id` scopes every row. Two composite foreign keys
-- make a cross-tenant reference a non-existent pair rather than a leak: `fk_work_item_labels_work_item`
-- binds `(organization_id, work_item_id)` to `work_items (organization_id, id)`, and the
-- self-referential `fk_work_item_labels_label` binds `(organization_id, label_id)` to this table's own
-- `(organization_id, id)`. That is the engine half of the trap the service also enforces in code: a
-- cross-tenant item or label id is a 404 with no write, never a row against someone else's work.
--
-- ## Identity is immutable
--
-- `organization_id` is what a row *is* — moving it to another studio is not an edit. The
-- `BEFORE UPDATE` trigger holds that at the engine, the way `work_item_checklist_items` (0051) does;
-- ADR-0001 layers 3 and 4 are application-side and a direct SQL session bypasses both.

CREATE TABLE work_item_labels (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  -- Set on ASSIGNMENT rows (the tagged work item); NULL on DEFINITION rows.
  work_item_id     CHAR(36)     NULL,
  -- Set on ASSIGNMENT rows (the definition row this points at); NULL on DEFINITION rows.
  label_id         CHAR(36)     NULL,
  -- Set on DEFINITION rows (the label's display name, unique per tenant); NULL on ASSIGNMENT rows.
  name             VARCHAR(120) NULL,
  -- Set on DEFINITION rows (a token from the fixed palette in schema.ts `WORK_LABEL_COLORS`);
  -- NULL on ASSIGNMENT rows.
  color            VARCHAR(20)  NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries; also the target of the
  -- self-referential label foreign key below.
  UNIQUE KEY uq_work_item_labels_org_id (organization_id, id),
  -- A label's name is unique per studio. Assignment rows carry a NULL name and a UNIQUE index
  -- treats NULLs as distinct, so they never collide here.
  UNIQUE KEY uq_work_item_labels_org_name (organization_id, name),
  -- Tagging is idempotent: one (work item, label) pair once. Definition rows carry NULLs in both
  -- columns and so are exempt from this constraint.
  UNIQUE KEY uq_work_item_labels_assignment (organization_id, work_item_id, label_id),
  -- The index the item's chips are read by: this tenant's assignment rows for one work item.
  KEY ix_work_item_labels_item (organization_id, work_item_id, id),
  -- An assignment can only ever name a work item of its own tenant.
  CONSTRAINT fk_work_item_labels_work_item
    FOREIGN KEY (organization_id, work_item_id) REFERENCES work_items (organization_id, id),
  -- An assignment can only ever name a label definition of its own tenant.
  CONSTRAINT fk_work_item_labels_label
    FOREIGN KEY (organization_id, label_id) REFERENCES work_item_labels (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A label row's tenant is immutable, for the reason `work_item_checklist_items`' trigger gives:
-- moving it to another studio would change what it is, silently.
DELIMITER $$

CREATE TRIGGER trg_work_item_labels_immutable
BEFORE UPDATE ON work_item_labels FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_labels.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
