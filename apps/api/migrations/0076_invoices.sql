-- 0076_invoices — FEAT: Billing & plan management (module 19) — invoice history (x179 slice).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Billing" (invoices), audit
-- 2026-09-27 rank #10 ("Billing Partial — invoice not built"), 07-DATA-MODEL §9 (index prefixes
-- lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §5-7 (composite tenant keys,
-- scoped reads), ADR-0001 (MySQL has no row-level security; the composite key and the app-side
-- tenant guard replace it). NEXT-SCOPES-13 reserves 0076 for x179.
--
-- ## Migration numbering
--
-- Numbered 0076 as reserved by pass21-queue.txt / NEXT-SCOPES-13 (x179 = 0076). The number is a
-- set member, not a position (migrator.db.test treats gaps as legitimate), so the integrator
-- renumbers this file only if a collision appears after the parallel merges.
--
-- ## What this migration is for
--
-- The billing audit is "Billing Partial — invoice not built": the subscription (x177) exists, but
-- there is no place to hold the invoices a subscription produces, and no screen that lists them.
-- This is the smallest useful unit that closes the *invoice history* half: an **invoice** — a
-- number, a billing period, an amount in integer cents, a currency, a status and an issued time —
-- as a durable, tenant-scoped, read-only record. This slice **reads** invoices; the rows are
-- produced by the subscription lifecycle or the seed. Generating real invoices from a payment
-- provider (Stripe test-mode first) is Needs-Peter and out of this slice — there is deliberately
-- no invoice mutation route here, and the runtime credential is granted no write on this table.
--
-- ## Tenant-scoped like every sibling
--
-- `invoices.organization_id` is `NOT NULL` and carries the `(organization_id, id)` key every
-- tenant table has, so a detail read can resolve one invoice by id *within the acting tenant* and
-- a cross-tenant id simply does not resolve — the resolve-before-authorize order the controller
-- relies on for its 404.
--
-- ## Money is integer cents, never a float
--
-- `amount_cents` is `BIGINT UNSIGNED NOT NULL`: an invoice total in the smallest currency unit, so
-- arithmetic and comparison are exact. A float would round; a billing total must not. `currency`
-- is a `CHAR(3)` ISO-4217 code (e.g. `USD`), stored uppercase.
--
-- ## `status` is an enum
--
-- `status` is `paid | open | void`, `NOT NULL DEFAULT 'open'` — the three states an invoice's
-- history shows. A void is kept, not deleted: "which invoices existed, and what became of them" is
-- the record a billing dispute is settled from.
--
-- ## Line items live in a bounded JSON column
--
-- `line_items` is a `JSON` column (nullable) holding the detail read's bounded array of line items
-- ({ description, quantity, unit_amount_cents, amount_cents }). It is detail, not a queryable
-- relation this slice needs, so it is carried inline rather than in a child table; a dedicated
-- `invoice_line_items` table with its own reads is a later slice if one is ever needed.
--
-- ## Identity is immutable
--
-- `organization_id` is what an invoice *is*: re-pointing an invoice at another tenant would move a
-- billing record, silently, into another studio's history. The `BEFORE UPDATE` trigger holds that
-- at the engine — the reason every other trigger in this schema exists, ADR-0001's app-side layers
-- being bypassed by a direct SQL session. The remaining columns are left editable for the
-- lifecycle a later provider-integration slice will own.

CREATE TABLE invoices (
  id               CHAR(36)      NOT NULL,
  organization_id  CHAR(36)      NOT NULL,
  -- The human-facing invoice number (e.g. `INV-2026-0001`). Unique within a tenant.
  number           VARCHAR(64)   NOT NULL,
  -- The billing period this invoice covers, as UTC instants.
  period_start     DATETIME(3)   NOT NULL,
  period_end       DATETIME(3)   NOT NULL,
  -- The total, in the smallest unit of `currency`. Integer, never a float; see the note above.
  amount_cents     BIGINT UNSIGNED NOT NULL,
  -- ISO-4217, stored uppercase.
  currency         CHAR(3)       NOT NULL,
  status           ENUM('paid', 'open', 'void') NOT NULL DEFAULT 'open',
  -- Detail read's bounded line-item array. Nullable — a summary row may carry no breakdown.
  line_items       JSON          NULL,
  -- When the invoice was issued. The list order leads with this.
  issued_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries; the detail read resolves an
  -- invoice by id within the acting tenant against it.
  UNIQUE KEY uq_invoices_org_id (organization_id, id),
  -- An invoice number is unique within a tenant, not globally.
  UNIQUE KEY uq_invoices_org_number (organization_id, number),
  -- 07-DATA-MODEL §9: the one list that exists — this tenant's invoices, newest issued first.
  -- Leads with `organization_id`.
  KEY ix_invoices_org_issued (organization_id, issued_at),
  CONSTRAINT fk_invoices_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An invoice's tenant is immutable: re-pointing it would move a billing record into another
-- studio's history, silently. The remaining columns stay editable for the later provider-driven
-- lifecycle (Needs-Peter); identity is not.
DELIMITER $$

CREATE TRIGGER trg_invoices_immutable
BEFORE UPDATE ON invoices FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'invoices.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
