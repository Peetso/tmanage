-- 0303_tax_document_labels — 52-28 tax-document labelling, R19-a.
--
-- Governing source: 52-FEATURE-GAPS-AGENCY-CORE §16.2 "52-28". `client_invoices.document_label`
-- already exists (0301, always 'invoice' until now) and is NOT added again. A KSA/EG VAT-registered
-- organization now drafts a proforma invoice by default; "tax invoice" needs a registration
-- reference (ETA uuid / ZATCA uuid / accounting-tool ref) recorded by hand (52-12 replaces it for KSA).
--
-- The 0301 trigger `trg_client_invoices_sent_immutable` refuses only money, currency, fx, dates,
-- client and number after send, so `document_label`, `tax_registration_ref`, `tax_registered_at`
-- and `tax_notice_shown` may move after send (the tax-registration route): no trigger change.
--
-- MariaDB-safe (Hostinger): plain ADD COLUMNs only — no ENUM, no generated column, no CHECK, no
-- IF NOT EXISTS. The closed vocabularies (labels, vat status, regimes) are checked by the
-- application (`packages/domain/src/finance/tax-document-rules.ts`).
-- Registry: no new table (schema.ts column edits only; tenant guard unchanged; grants unchanged).

ALTER TABLE client_invoices
  ADD COLUMN tax_registration_ref VARCHAR(64) NULL,
  ADD COLUMN tax_registered_at DATETIME(3) NULL,
  ADD COLUMN tax_notice_shown TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE org_finance_profiles
  ADD COLUMN vat_registration_status VARCHAR(16) NOT NULL DEFAULT 'not_registered',
  ADD COLUMN einvoice_regime VARCHAR(8) NULL;
