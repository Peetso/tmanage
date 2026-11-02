-- 0315_credit_note_export_marks — 52-11 accounting export follow-up, R23-d.
--
-- Governing source: 52-FEATURE-GAPS-AGENCY-CORE "52-11" ("exported invoices and credit notes are
-- marked … re-export needs the `reexport` flag"). 0301 gave `client_invoices` the
-- `exported_at` / `export_target` mark; `client_credit_notes` had none, so a credit note exported
-- twice was silently posted twice in the accounting file. The export now stamps both tables in the
-- same transaction and refuses (409 `already_exported`) a second run without `reexport`.
--
-- - `client_credit_notes.exported_at` (DATETIME(3) NULL) — when the last export included the note.
-- - `client_credit_notes.export_target` (VARCHAR(24) NULL) — the target of that export (closed
--   list `EXPORT_TARGETS`, checked in the API).
-- - `ix_ccn_org_exported (organization_id, exported_at)`.
--
-- Triggers: only `trg_client_credit_notes_org_immutable` exists for this table (0301); there is no
-- issued-immutability trigger on credit notes (unlike invoices), so the two new columns need no
-- trigger change.
--
-- MariaDB-safe (Hostinger): no ENUM, no CHECK, no generated column, no IF NOT EXISTS. Additive only.
-- Registry: schema.ts (`clientCreditNotes` columns + index); no new table, so no tenant-guard or
-- users.sql grant change (UPDATE on `client_credit_notes` exists, 0301 block); the migrator is
-- directory-driven.

ALTER TABLE client_credit_notes
  ADD COLUMN exported_at DATETIME(3) NULL,
  ADD COLUMN export_target VARCHAR(24) NULL;

ALTER TABLE client_credit_notes
  ADD KEY ix_ccn_org_exported (organization_id, exported_at);
