-- 0099_invoice_line_items — FEAT: Billing & plan management (module 19) — per-invoice line-item
-- detail (x225 slice).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Billing" (invoices → line detail),
-- 07-DATA-MODEL §9 (index prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §5-7 (composite tenant keys, scoped reads), ADR-0001 (MySQL has no row-level security;
-- the composite key and the app-side tenant guard replace it). pass23-queue.txt reserves 0099 for
-- x225.
--
-- ## Migration numbering
--
-- Numbered 0099 as reserved by pass23-queue.txt (x225 = 0099). The number is a set member, not a
-- position (migrator.db.test treats gaps as legitimate), so the integrator renumbers this file only
-- if a collision appears after the parallel merges.
--
-- ## What this migration is for
--
-- x179 built the invoice *header* history (list + detail), carrying a bounded line-item array inline
-- in the invoice's `line_items` JSON column for the detail drawer. This slice promotes the breakdown
-- to a durable, queryable child table so a per-invoice line read has its own tenant-scoped endpoint
-- and the summed lines can be reconciled against the stored header total. This slice **reads** line
-- items; rows are produced by the subscription lifecycle or the seed. Generating real invoices and
-- their lines from a payment provider is Needs-Peter and out of this slice — there is deliberately no
-- line mutation route here, and the runtime credential is granted no write on this table.
--
-- ## Tenant-scoped like every sibling
--
-- `invoice_line_items.organization_id` is `NOT NULL` and carries the `(organization_id, id)` key
-- every tenant table has. `(organization_id, invoice_id)` references `invoices (organization_id, id)`
-- — the composite parent key x179 added — so a line can only ever belong to an invoice in the same
-- tenant; a cross-tenant `invoice_id` simply does not resolve.
--
-- ## Money is integer minor units, never a float
--
-- `unit_amount_cents` and `amount_cents` are `BIGINT UNSIGNED NOT NULL`: minor units, so arithmetic
-- and comparison are exact and the summed lines reconcile to the header total without float drift. A
-- float would round; a billing total must not. `quantity` is `INT UNSIGNED NOT NULL`.
--
-- ## Identity is immutable
--
-- `organization_id` and `invoice_id` are what a line *is*: re-pointing a line would move a billing
-- detail into another invoice — or another studio's history — silently. The `BEFORE UPDATE` trigger
-- holds that at the engine, the reason every other trigger in this schema exists (ADR-0001's
-- app-side layers being bypassed by a direct SQL session).

CREATE TABLE invoice_line_items (
  id                CHAR(36)        NOT NULL,
  organization_id   CHAR(36)        NOT NULL,
  invoice_id        CHAR(36)        NOT NULL,
  -- A line's human-facing label (e.g. `Pro plan — Aug 2026`).
  description       VARCHAR(255)    NOT NULL,
  -- How many units this line bills. Integer, never a float.
  quantity          INT UNSIGNED    NOT NULL,
  -- The per-unit price, in the smallest currency unit. Integer, never a float.
  unit_amount_cents BIGINT UNSIGNED NOT NULL,
  -- The line total, in the smallest currency unit. Integer; summed lines reconcile to the header.
  amount_cents      BIGINT UNSIGNED NOT NULL,
  -- Stable display order within an invoice; the list reads by this then id.
  position          INT UNSIGNED    NOT NULL DEFAULT 0,
  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_invoice_line_items_org_id (organization_id, id),
  -- 07-DATA-MODEL §9: the one list that exists — a single invoice's lines, in display order.
  -- Leads with `organization_id`.
  KEY ix_invoice_line_items_org_invoice (organization_id, invoice_id, position),
  CONSTRAINT fk_invoice_line_items_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- A line belongs to an invoice in the same tenant, against x179's composite parent key.
  CONSTRAINT fk_invoice_line_items_invoice
    FOREIGN KEY (organization_id, invoice_id) REFERENCES invoices (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A line's tenant and invoice are immutable: re-pointing either would move a billing detail into
-- another invoice or another studio's history, silently. The remaining columns stay editable for the
-- later provider-driven lifecycle (Needs-Peter); identity is not.
DELIMITER $$

CREATE TRIGGER trg_invoice_line_items_immutable
BEFORE UPDATE ON invoice_line_items FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'invoice_line_items.organization_id is immutable';
  END IF;
  IF NEW.invoice_id <> OLD.invoice_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'invoice_line_items.invoice_id is immutable';
  END IF;
END$$

DELIMITER ;
