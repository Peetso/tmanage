-- 0082_billing_contacts — org-scoped billing/notification contacts (Billing, module 19, x199).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Billing (billing contacts — the
-- people a studio nominates to receive its billing and account notices); 04-SECURITY-PRIVACY §4 (no
-- payment instruments — card and bank numbers are the provider's, never in this database);
-- 07-DATA-MODEL §9 (index prefixes lead with `organization_id`); 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §6 (composite tenant keys).
--
-- ## Migration number
--
-- Pass 22 reserves 0081–0093 in slice-id order (NEXT-SCOPES-14 header); x199's reservation is 0082.
-- The highest migration present on this slice's base (x180-billing-profile) is 0077; the intervening
-- reservations belong to sibling branches not yet integrated, so 0082 sits above every reservation.
-- The migrator applies files in ascending numeric order and a gap is not an error (it rejects only a
-- NEW file numbered *below* an applied one), so 0082 on top of 0077 is correct on this base. If the
-- integration renumbers the reservations, the integrator renumbers this file with them; nothing here
-- depends on the literal 0082 beyond the filename.
--
-- ## What this migration is for
--
-- The billing profile (0077) carries a single billing contact email on the org row. A studio needs
-- more than one nominated contact — an accounts-payable address, an owner, a finance manager — each
-- with a name, an email and an optional role label. This is the smallest useful unit that adds them:
-- an **org-scoped list of billing contacts**, added, listed and removed behind `org.manage`.
--
-- ## No payment instruments, ever
--
-- 04-SECURITY-PRIVACY §4: card numbers, bank numbers and every other payment instrument are held by
-- the payment provider, never here. This table carries only a contact's name, email and role label —
-- there is no PAN column, no bank column, and the application rejects any card/PAN-shaped value into
-- these fields (`contacts.service.ts`) so a value that looks like a card number never lands here.
--
-- ## No email is sent
--
-- This slice records contacts; it does not deliver to them. Email delivery of billing notices is
-- Needs-Peter (an external provider), so nothing here queues or sends mail — the row is the whole
-- effect.
--
-- ## Org-scoped
--
-- A billing contact belongs to the organization, not a project or a person: there is no `project_id`
-- and no `created_by`. The tenant key is `organization_id` alone, bound to `organizations`. Contacts
-- are added and removed, never edited in place, so the app is granted INSERT and DELETE (no UPDATE):
-- to change a contact a studio removes it and adds it again.
--
-- ## Identity is immutable
--
-- `organization_id` is what a contact *belongs to*; the `BEFORE UPDATE` trigger holds it at the
-- engine, the reason every other identity trigger in this schema exists (ADR-0001 layers 3 and 4 are
-- application-side and a direct SQL session bypasses both). There is no UPDATE path in the app, but
-- the trigger pins identity for every credential regardless.

CREATE TABLE billing_contacts (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The contact's display name. Bounded at 190 by the application before it is written.
  name            VARCHAR(190) NOT NULL,
  -- The contact's email. Non-secret; bounded at 320 (RFC 5321) and format-validated by the
  -- application. NOT a payment instrument — the application rejects any card/PAN-shaped value here.
  email           VARCHAR(320) NOT NULL,
  -- An optional role label (e.g. "Accounts payable", "Owner"). Nullable; bounded at 80 by the app.
  role            VARCHAR(80)  NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_billing_contacts_org_id (organization_id, id),
  -- The org-scoped list read leads with organization_id, newest first.
  KEY ix_billing_contacts_org_created (organization_id, created_at),
  CONSTRAINT fk_billing_contacts_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A contact's tenant is immutable, the reason `billing_profiles`' trigger gives. There is no update
-- endpoint in the app; the trigger pins identity for every credential regardless.
DELIMITER $$

CREATE TRIGGER trg_billing_contacts_immutable
BEFORE UPDATE ON billing_contacts FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'billing_contacts.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
