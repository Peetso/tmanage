-- 0152_billing_tax_details — org-scoped tax / legal-entity billing details (Billing, module 19, x283).
--
-- Governing sources: 49-PRICING-ENTITLEMENTS (the org's tax/VAT id and legal billing entity shown on
-- the billing profile and later on invoices); 33-LEGAL-AND-COMPLIANCE (a studio's legal name,
-- registration number and tax country are the invoicing entity, not a payment instrument);
-- 04-SECURITY-PRIVACY §4 (no payment instruments — card and bank numbers are the provider's, never in
-- this database); 07-DATA-MODEL §9 (index prefixes lead with `organization_id`);
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## Migration number
--
-- Pass 25 reserves 0145–0173 in slice-id order (pass25-queue header map); x283's reservation is 0152.
-- The highest migration present on this slice's base (origin/master after pass 24) is below 0145; the
-- intervening reservations belong to sibling branches not yet integrated, so 0152 sits above every
-- reservation on this base. The migrator applies files in ascending numeric order and a gap is not an
-- error (it rejects only a NEW file numbered *below* an applied one), so 0152 on top of the base is
-- correct. If the integration renumbers the reservations, the integrator renumbers this file with them;
-- nothing here depends on the literal 0152 beyond the filename.
--
-- ## What this migration is for
--
-- The billing profile (0077) carries a contact email, a company name, a free-text tax id and a postal
-- address on one org row; the billing-contacts list (0082) carries the people notified. Neither is the
-- studio's *legal invoicing entity*: the legal name, a registration number and the tax country that
-- decide how an invoice is addressed and taxed. This is the smallest useful unit that records them —
-- an **org-scoped single row of tax / legal-entity details**, read and upserted behind `org.manage`,
-- distinct from the billing-profile contact slice (legal/tax fields only, no contact or address here).
--
-- ## No payment instruments, ever
--
-- 04-SECURITY-PRIVACY §4: card numbers, bank numbers and every other payment instrument are held by
-- the payment provider, never here. This table carries only a legal name, a registration number, a
-- non-secret tax id and a 2-letter tax-country code — there is no PAN column and no bank column, and
-- the application rejects any card/PAN-shaped value into these fields (`tax-details.service.ts`).
--
-- ## No delivery, no charge
--
-- This slice records the entity; it delivers nothing and charges nothing. Invoice rendering that
-- consumes these fields is a later slice; the row is the whole effect here.
--
-- ## Org-scoped, one row per org
--
-- These details belong to the organization, not a project or a person: there is no `project_id` and no
-- `created_by`. The tenant key is `organization_id` alone, bound to `organizations`, and
-- `uq_billing_tax_details_org` (organization_id alone) is the upsert key — the read/upsert repository
-- writes `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place and one
-- organization can never accumulate two rows. `organization_id` is immutable at the engine (the
-- `BEFORE UPDATE` trigger), the reason every other identity trigger in this schema exists (ADR-0001
-- layers 3 and 4 are application-side and a direct SQL session bypasses both).

CREATE TABLE billing_tax_details (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  -- The legal invoicing name. Required (the application refuses an empty value); bounded at 190 by the
  -- application before it is written.
  legal_name       VARCHAR(190) NOT NULL,
  -- A tax/VAT registration id (VAT/EIN/etc.). Non-secret; nullable; bounded at 64 by the application.
  -- NOT a payment instrument — the application rejects any card/PAN-shaped value here.
  tax_id           VARCHAR(64)  NULL,
  -- A company/registration number. Non-secret; nullable; bounded at 120 by the application. NOT a
  -- payment instrument — the application rejects any card/PAN-shaped value here.
  registration_no  VARCHAR(120) NULL,
  -- The tax country as a 2-letter ISO 3166-1 alpha-2 code, upper-cased and validated against the
  -- application's closed country allowlist before it is written (an unknown code is a 400, no upsert).
  tax_country      CHAR(2)      NOT NULL,
  created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can reference
  -- this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_billing_tax_details_org_id (organization_id, id),
  -- One row per organization. This is the upsert key: the read/upsert repository writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place.
  UNIQUE KEY uq_billing_tax_details_org (organization_id),
  CONSTRAINT fk_billing_tax_details_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The row's tenant is immutable, the reason `billing_profiles`' trigger gives. The legal/tax fields are
-- left editable at the engine — that is the point of the upsert; identity is not.
DELIMITER $$

CREATE TRIGGER trg_billing_tax_details_immutable
BEFORE UPDATE ON billing_tax_details FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'billing_tax_details.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
