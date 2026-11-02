-- 0311_einvoicing_chain — 52-12 e-invoicing readiness (backend, part 2), R21-d.
--
-- Governing source: 52-FEATURE-GAPS-AGENCY-CORE "52-12" scope 1 and 4. Every issued fiscal
-- document of a `zatca` organization carries its place in the hash chain:
--   `zatca_icv`      — invoice counter value, gapless per organization across invoices AND credit
--                      notes (one counter), assigned at send / issue inside the same transaction
--                      that takes the document number. NULL for drafts and for other regimes.
--   `zatca_pih`      — previous invoice hash: the `zatca_xml_hash` of the document with
--                      icv - 1; the first document's is SHA-256 of '0'.
--   `zatca_xml_hash` — SHA-256 hex of the UBL 2.1 XML built from the stored row. The XML is
--                      deterministic, so a rebuild whose hash differs from this one is a tamper
--                      signal (`GET …/client-invoices/:id/einvoice` reports `hashMatches`).
--   `zatca_status`   — not_applicable | ready | signed | reported | cleared | rejected. Only
--                      `not_applicable` and `ready` are written today; signing, reporting and
--                      clearance are a later pass (the vocabulary is stored now, stated).
--
-- Deviation from the planning text: no `zatca_uuid` column — `client_invoices.id` /
-- `client_credit_notes.id` (CHAR(36), UUIDv7) IS the document UUID the XML carries.
-- Credit notes live in their own table (0301), so the same four columns are added there and the
-- chain spans both tables; the per-table UNIQUE keys hold within a table and the org-wide
-- serialisation (a FOR UPDATE on the org's `org_finance_profiles` row) keeps one counter.
-- A UNIQUE over a nullable column admits many NULLs: non-zatca orgs never collide.
--
-- MariaDB-safe (Hostinger): plain ADD COLUMN / ADD UNIQUE KEY only — VARCHAR instead of ENUM, no
-- CHECK, no generated column, no IF NOT EXISTS. The 0301 sent-immutable trigger is unchanged.
-- Registry: no new table (schema.ts columns only; the tenant guard already knows both tables).
-- users.sql unchanged: the values are written by the same UPDATE / INSERT the send and the credit
-- note already hold.

ALTER TABLE client_invoices
  ADD COLUMN zatca_icv INT UNSIGNED NULL,
  ADD COLUMN zatca_pih CHAR(64) NULL,
  ADD COLUMN zatca_xml_hash CHAR(64) NULL,
  ADD COLUMN zatca_status VARCHAR(16) NOT NULL DEFAULT 'not_applicable',
  ADD UNIQUE KEY uq_client_invoices_org_icv (organization_id, zatca_icv);

ALTER TABLE client_credit_notes
  ADD COLUMN zatca_icv INT UNSIGNED NULL,
  ADD COLUMN zatca_pih CHAR(64) NULL,
  ADD COLUMN zatca_xml_hash CHAR(64) NULL,
  ADD COLUMN zatca_status VARCHAR(16) NOT NULL DEFAULT 'not_applicable',
  ADD UNIQUE KEY uq_client_credit_notes_org_icv (organization_id, zatca_icv);
