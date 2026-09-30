-- 0151_billing_purchase_orders — org-scoped purchase-order (PO) references (Billing &
-- entitlements, module 19, x282).
--
-- Governing sources: 49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY §Billing; 38-COMPLETE-PRODUCT-
-- SCOPE-AND-MODULE-MAP §Billing; 22-SCREEN §Billing profile; 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §6 (composite tenant keys); 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`).
--
-- ## Migration number
--
-- Pass 25 reserves 0145–0173 in slice-id order; x282's reservation is 0151 (pass25-queue header
-- map). The migrator applies files in ascending numeric order and a gap is not an error (it rejects
-- only a NEW file numbered *below* an applied one), so 0151 above the base's highest reservation is
-- correct on this base. Nothing here depends on the literal 0151 beyond the filename.
--
-- ## What this migration is for
--
-- A billing admin needs to record the purchase-order references their finance department issues, so a
-- later invoice can cite one. This adds the smallest useful unit for that — an **org-scoped PO
-- reference**: a `po_number` (unique per organization), an optional `amount_minor` in the smallest
-- unit of an optional ISO-4217 `currency`, an optional `note`, and an open/closed `status`. It is a
-- record at rest, not a payment: nothing here charges, transfers, or stores a payment instrument.
--
-- ## Org-scoped, not project-owned
--
-- Like `billing_usage_alerts` (0083) and `billing_contacts` (0082), a PO reference belongs to the
-- organization, not a project: billing is an org-admin concern (`org.manage`). So there is no
-- `project_id` and no project composite foreign key — the tenant key is `organization_id` alone,
-- bound to `organizations`. One PO number per organization
-- (`uq_billing_purchase_orders_org_number`): a second row with the same number is a conflict (409),
-- not a duplicate.
--
-- ## Identity is immutable; status is editable
--
-- `organization_id` and `po_number` are what a PO reference *is*; the `BEFORE UPDATE` trigger holds
-- them at the engine (ADR-0001 layers 3 and 4 are application-side and a direct SQL session bypasses
-- both). `status` is the one column the update path changes (open → closed, idempotent), so the app
-- is granted INSERT, UPDATE and DELETE: a PO is recorded, closed, and may be removed.

CREATE TABLE billing_purchase_orders (
  id               CHAR(36)      NOT NULL,
  organization_id  CHAR(36)      NOT NULL,
  -- The finance-issued PO reference. Non-empty (validated by the application before any write) and
  -- unique per organization. Stored verbatim; the application never parses it.
  po_number        VARCHAR(128)  NOT NULL,
  -- The PO's committed amount, in the smallest unit of `currency`. Integer, never a float, so
  -- arithmetic and comparison are exact. Optional: a PO may be recorded before its value is known.
  amount_minor     BIGINT UNSIGNED,
  -- The ISO-4217 code `amount_minor` is expressed in. Optional, and only meaningful with an amount.
  currency         CHAR(3),
  -- A free-text note (purpose, requester). Optional.
  note             VARCHAR(500),
  -- Whether the PO is still open for invoices to cite, or has been closed. Editable via the close
  -- path (open → closed, idempotent).
  status           ENUM('open', 'closed') NOT NULL DEFAULT 'open',
  created_at       DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can reference
  -- this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_billing_purchase_orders_org_id (organization_id, id),
  -- One PO number per organization: a second row with the same number is a conflict, not a duplicate.
  -- Leads with `organization_id` per 07-DATA-MODEL §9 and is the list/lookup index.
  UNIQUE KEY uq_billing_purchase_orders_org_number (organization_id, po_number),
  CONSTRAINT fk_billing_purchase_orders_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A PO reference's tenant and number are immutable, the reason `billing_usage_alerts`' trigger gives.
-- `status` is left editable at the engine for the close path; identity is not.
DELIMITER $$

CREATE TRIGGER trg_billing_purchase_orders_immutable
BEFORE UPDATE ON billing_purchase_orders FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'billing_purchase_orders.organization_id is immutable';
  END IF;
  IF NEW.po_number <> OLD.po_number THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'billing_purchase_orders.po_number is immutable';
  END IF;
END$$

DELIMITER ;
