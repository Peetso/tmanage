-- 0304_finance_exports — 52-11 accounting export by file (R19 slice b).
--
-- ## What this migration is for
--
-- A finance manager downloads one zip per accounting system (Zoho Books, Odoo, Qoyod, Wafeq,
-- QuickBooks Online, Xero, generic CSV) holding the period's invoices, credit notes, payments,
-- customers and/or expenses, a bilingual README and a `manifest.json` with the SHA-256 of every
-- file. The zip is streamed back once and never stored (no Drive/OneDrive driver yet): this table
-- keeps the history only — what was exported, when, by whom, how many records and the manifest's
-- SHA-256. A re-download is a re-run.
--
-- - `finance_exports` (TENANT, new) — `target` ('zoho_books' | 'odoo' | 'qoyod' | 'wafeq' |
--   'quickbooks' | 'xero' | 'generic') and `kinds` (comma list of 'invoices' | 'credit_notes' |
--   'payments' | 'customers' | 'expenses') are closed lists checked in the application.
--   `row_counts_json` is `{kind: records}`; `latin_only` records the Latin-only switch.
--   Append-only: no UPDATE, no DELETE.
-- - The exported invoices are marked in the same transaction through the 0301 columns
--   `client_invoices.exported_at` / `export_target` (the 0301 sent-immutability trigger lets both
--   move after send). `client_credit_notes` carries no such column; a credit note is not marked.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATE / DATETIME(3), composite tenant key, no generated columns, no CHECK, no JSON
-- column type (TEXT), utf8mb4_unicode_ci — the 0283 / 0291 / 0299 / 0301 conventions.
--
-- ## Grants (scripts/db/users.sql, 0304 block)
--
-- `tmanage_app`: SELECT, INSERT on `finance_exports`; UPDATE on `client_invoices` restated (the
-- exported marks). `tmanage_worker`: nothing.

CREATE TABLE finance_exports (
  id                CHAR(36)      NOT NULL,
  organization_id   CHAR(36)      NOT NULL,
  -- 'zoho_books' | 'odoo' | 'qoyod' | 'wafeq' | 'quickbooks' | 'xero' | 'generic' (application).
  target            VARCHAR(24)   NOT NULL,
  period_start      DATE          NOT NULL,
  period_end        DATE          NOT NULL,
  -- Comma list of the exported kinds (application-checked).
  kinds             VARCHAR(64)   NOT NULL,
  row_counts_json   TEXT          NOT NULL,
  manifest_sha256   CHAR(64)      NOT NULL,
  latin_only        TINYINT(1)    NOT NULL DEFAULT 0,
  created_by        CHAR(36)      NOT NULL,
  created_at        DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_finance_exports_org_id (organization_id, id),
  KEY ix_finance_exports_org_created (organization_id, created_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

-- organization_id is immutable (ADR-0001 layer 1), as on every tenant table.
CREATE TRIGGER trg_finance_exports_org_immutable
BEFORE UPDATE ON finance_exports FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'finance_exports.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
