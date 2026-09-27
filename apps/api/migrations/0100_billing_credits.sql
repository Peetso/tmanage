-- 0100_billing_credits — org-scoped manual credit / adjustment ledger (Billing & entitlements,
-- module 19, x226).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Billing ("credits/adjustments"); 25-
-- AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys); 07-DATA-MODEL §9 (index prefixes
-- lead with `organization_id`); 49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY (bookkeeping only).
--
-- ## Migration number
--
-- The queue header (pass 23) reserves 0100 for x226 in slice-id order. The highest migration present
-- on this slice's base (origin/master) is 0093; 0094–0099 are reserved by sibling pass-23 branches not
-- yet integrated, so 0100 sits above every reservation. The migrator applies files in ascending numeric
-- order and a gap is not an error (it rejects only a NEW file numbered *below* an applied one), so 0100
-- on top of 0093 is correct on this base. If the integration renumbers the reservations, the integrator
-- renumbers this file with them; nothing here depends on the literal 0100 beyond the filename.
--
-- ## What this migration is for
--
-- The Billing module holds an org's billing profile, contacts and usage-alert thresholds, but no record
-- of a manual credit or adjustment applied to the account. This adds the smallest useful unit for that —
-- an **org-scoped credit ledger entry**: a signed `amount` in integer minor units (a positive credit or
-- a negative adjustment), a free-text `reason`, and who posted it and when. It is a *bookkeeping record*
-- at rest, not a settlement: nothing here moves money, calls a payment gateway, or changes an invoice
-- balance (real settlement is Needs-Peter). The running balance the read side reports is computed in the
-- application by summing `amount` over the tenant's rows; it is never stored and never triggers a charge.
--
-- ## Append-only
--
-- A posted credit is immutable: it is never edited or deleted. There is therefore no `updated_at` column
-- and no update path. Immutability is enforced by the grant (`users.sql` gives the runtime INSERT and
-- SELECT only — no UPDATE, no DELETE), so a runtime credential cannot amend or remove a posted row; a
-- correction is a new, offsetting entry, the way a ledger works. This is the `insight_snapshots` (0090)
-- and `audit_events` posture — insert-only registers carry no mutation trigger because there is no
-- mutation path to pin.
--
-- ## Org-scoped, not project-owned
--
-- Like `billing_usage_alerts` (0083) and `billing_contacts` (0082), a credit belongs to the organization,
-- not a project: billing is an org-admin concern (`org.manage`). So there is no `project_id` and no
-- project composite foreign key — the tenant key is `organization_id` alone, bound to `organizations`.

CREATE TABLE billing_credits (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The credit (positive) or adjustment (negative) in integer minor units. Bounded by the application
  -- (non-zero, |amount| <= 100000000) before the write; the CHECK pins the same bound at the engine.
  amount          INT          NOT NULL,
  -- Why the credit was posted. Free text, bounded by the application (1..500) before the write; stored
  -- as a VARCHAR so an over-long reason cannot land.
  reason          VARCHAR(500) NOT NULL,
  created_by      CHAR(36)     NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can reference
  -- this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_billing_credits_org_id (organization_id, id),
  -- The list index: a tenant's credits, newest-first. Leads with `organization_id` per 07-DATA-MODEL §9.
  KEY ix_billing_credits_org_created (organization_id, created_at),
  CONSTRAINT fk_billing_credits_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The actor. References users (id) without organization_id because a user is not tenant-owned — the
  -- same shape `billing_usage_alerts.created_by` (0083) uses.
  CONSTRAINT fk_billing_credits_created_by
    FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT chk_billing_credits_amount
    CHECK (amount <> 0 AND amount BETWEEN -100000000 AND 100000000)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
