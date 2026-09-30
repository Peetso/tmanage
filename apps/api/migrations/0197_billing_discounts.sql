-- 0197_billing_discounts — org-scoped discount / adjustment register (Billing & plan management,
-- module 19, x330).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Billing & plan management
-- ("adjustments"); 49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY (bookkeeping only); 25-AUTHORIZATION-
-- AND-TENANT-ISOLATION §6 (composite tenant keys); 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`).
--
-- ## Migration number
--
-- The pass-26 queue header reserves 0197 for x330 in slice-id order. The highest migration present on
-- this slice's base (origin/master) is lower; the reserved numbers between belong to sibling pass-26
-- branches not yet integrated. The migrator applies files in ascending numeric order and a gap is not
-- an error (it rejects only a NEW file numbered *below* an applied one), so 0197 on this base is
-- correct. If the integration renumbers the reservations it renumbers this file with them; nothing here
-- depends on the literal 0197 beyond the filename.
--
-- ## What this migration is for
--
-- The Billing module records an org's plan, contacts, usage-alert thresholds and a manual credit ledger
-- (`billing_credits`, 0100), but has no record of a standing discount or adjustment a billing owner
-- applies to the account. This adds the smallest useful unit for that — an **org-scoped discount
-- record**: a `label`, a `kind` (`percent` or `fixed`), an `amount`, and an optional `expires_on`. It is
-- a *bookkeeping record* at rest, not a settlement: nothing here moves money, calls a payment gateway,
-- computes a charge or touches an invoice (applying a discount to a real charge is Needs-Peter / Stripe).
-- Whether a record is active or expired is decided on the read side against the process clock; it is
-- never stored.
--
-- ## Distinct from the neighbours
--
-- `billing_credits` (0100, x226) is a prepaid/adjustment *ledger* summed into a balance;
-- `billing_usage_alerts` (0083, x200) is a threshold rule. A discount is neither: it is a standing
-- percentage-off or fixed-amount-off record with an optional expiry. So it is its own table, not a row
-- kind of either.
--
-- ## Records only — create and delete, no edit
--
-- A discount is created and deleted; it is never edited (a change is a delete-and-recreate). The grant
-- (`users.sql`) gives the runtime INSERT and DELETE only — no UPDATE — so a runtime credential cannot
-- amend a posted row. There is no `updated_at` column.
--
-- ## Org-scoped, not project-owned
--
-- Like `billing_usage_alerts` (0083), `billing_contacts` (0082) and `billing_credits` (0100), a discount
-- belongs to the organization, not a project: billing is an org-admin concern (`org.manage`). So there
-- is no `project_id` and no project composite foreign key — the tenant key is `organization_id` alone,
-- bound to `organizations`.

CREATE TABLE billing_discounts (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- A short human label for the adjustment. Free text, bounded by the application (1..200) before the
  -- write; stored as a VARCHAR so an over-long label cannot land.
  label           VARCHAR(200) NOT NULL,
  -- The adjustment kind. Bounded to the allowlist by the application before the write; the CHECK pins
  -- the same allowlist at the engine.
  kind            VARCHAR(16)  NOT NULL,
  -- The adjustment magnitude in integer units: for `percent` a whole percentage 0..100, for `fixed` a
  -- non-negative amount in integer minor units. Bounded by the application before the write; the CHECK
  -- pins the same bounds at the engine.
  amount          INT          NOT NULL,
  -- Optional expiry (a calendar date, no time). NULL means the record never expires. The read side
  -- marks a record expired when `expires_on` is before the process clock's date.
  expires_on      DATE         NULL,
  created_by      CHAR(36)     NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can reference
  -- this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_billing_discounts_org_id (organization_id, id),
  -- The list index: a tenant's discounts, newest-first. Leads with `organization_id` per 07-DATA-MODEL §9.
  KEY ix_billing_discounts_org_created (organization_id, created_at),
  CONSTRAINT fk_billing_discounts_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The actor. References users (id) without organization_id because a user is not tenant-owned — the
  -- same shape `billing_credits.created_by` (0100) uses.
  CONSTRAINT fk_billing_discounts_created_by
    FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT chk_billing_discounts_kind
    CHECK (kind IN ('percent', 'fixed')),
  -- Non-negative always; a percentage is capped at 100; a fixed amount is capped at the same ceiling the
  -- credit ledger uses. The application enforces the same bounds before the write.
  CONSTRAINT chk_billing_discounts_amount
    CHECK (amount >= 0 AND amount <= 100000000 AND (kind <> 'percent' OR amount <= 100))
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
