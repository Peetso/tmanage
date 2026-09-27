-- 0077_billing_profiles — org-scoped billing profile (Billing, module 19, x180).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Billing ("billing settings" — the
-- billing contact, tax id and address a studio keeps); 04-SECURITY-PRIVACY §4 (no payment
-- instruments — card and bank numbers are held by the provider, never in this database);
-- 07-DATA-MODEL §9 (index prefixes lead with `organization_id`); 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §6 (composite tenant keys).
--
-- ## Migration number
--
-- Pass 21 reserves 0060–0080 in slice-id order; x180's reservation is 0077 (pass21-queue header).
-- The highest migration present on this slice's base (master bcfe397) is 0052; 0053–0076 are
-- reserved by sibling pass-21 branches not yet integrated, so 0077 sits above every reservation.
-- The migrator applies files in ascending numeric order and a gap is not an error (it rejects only a
-- NEW file numbered *below* an applied one), so 0077 on top of 0052 is correct on this base. If the
-- integration renumbers the reservations, the integrator renumbers this file with them; nothing here
-- depends on the literal 0077 beyond the filename.
--
-- ## What this migration is for
--
-- Module 19 (Billing) has a subscription but no *billing profile*: the non-secret metadata a studio
-- keeps for its invoices — a billing contact email, a company name, a tax id and a postal address.
-- This is the smallest useful unit that adds one — an **org-scoped billing profile**, exactly one
-- row per organization, read and updated behind `org.manage`.
--
-- ## No payment instruments, ever
--
-- 04-SECURITY-PRIVACY §4 is explicit: card numbers, bank numbers and every other payment instrument
-- are held by the payment provider, never in this database. This table carries only billing
-- *metadata* — there is no PAN column, no bank column, and the application rejects any card/PAN-shaped
-- input into these fields (`profile.controller.ts`) so a value that looks like a card number never
-- lands here at all.
--
-- ## Org-scoped, one row per org
--
-- A billing profile belongs to the organization, not a project or a person: there is no `project_id`
-- and no `created_by`. The tenant key is `organization_id` alone, bound to `organizations`. The
-- `uq_billing_profiles_org` unique on `organization_id` alone is the upsert key: the read/upsert
-- repository writes `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in
-- place and one organization can never accumulate two profiles.
--
-- ## `address_json` is a JSON object
--
-- The postal address is a small, fixed set of fields (`line1`, `line2`, `city`, `region`,
-- `postalCode`, `country`), read and written whole with the profile and never queried across
-- organizations, so it is one `JSON` column rather than six scalar columns — the same division
-- `saved_views.config` (0034) and `work_forms.fields_json` (0052) use. Shape validation is the
-- application's (`profile.controller.ts`).
--
-- ## Identity is immutable
--
-- `organization_id` is what a profile *is*; the `BEFORE UPDATE` trigger holds it at the engine, the
-- reason every other identity trigger in this schema exists (ADR-0001 layers 3 and 4 are
-- application-side and a direct SQL session bypasses both). Everything else — the contact, tax id and
-- address — is editable, which is the whole point of the PUT, so this slice grants the app INSERT and
-- UPDATE (no DELETE): a profile is created and edited, never removed by a runtime credential.

CREATE TABLE billing_profiles (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The billing contact address. Non-secret metadata; nullable because a profile may be created with
  -- only some fields filled in. Bounded by the application at 254 (RFC 5321) before it is written.
  billing_email   VARCHAR(320) NULL,
  -- The legal/invoicing name. Nullable; bounded at 190 by the application.
  company_name    VARCHAR(190) NULL,
  -- A tax registration id (VAT/EIN/etc.). Non-secret; nullable; bounded at 64 by the application. NOT
  -- a payment instrument — the application rejects any card/PAN-shaped value here.
  tax_id          VARCHAR(64)  NULL,
  -- The postal address as one JSON object: `{ line1, line2, city, region, postalCode, country }`.
  -- Shape and bounds are the application's; the column stores it whole.
  address_json    JSON         NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                               ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_billing_profiles_org_id (organization_id, id),
  -- One row per organization. This is the upsert key: the read/upsert repository writes
  -- `INSERT ... ON DUPLICATE KEY UPDATE` against it, so a second save updates in place.
  UNIQUE KEY uq_billing_profiles_org (organization_id),
  CONSTRAINT fk_billing_profiles_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A profile's tenant is immutable, the reason `work_forms`' trigger gives. The contact, tax id and
-- address are left editable at the engine — that is the point of the update path; identity is not.
DELIMITER $$

CREATE TRIGGER trg_billing_profiles_immutable
BEFORE UPDATE ON billing_profiles FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'billing_profiles.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
