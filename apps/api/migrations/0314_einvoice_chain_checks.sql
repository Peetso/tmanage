-- 0314_einvoice_chain_checks — 52-12 e-invoicing readiness (part 3b), R22-b.
--
-- Governing source: 52-FEATURE-GAPS-AGENCY-CORE "52-12" Security ("Tampering: the chain detects any
-- out-of-order or edited invoice — the nightly reconciler walks the chain and alerts on a break")
-- and Acceptance ("chain unbroken after 100 invoices + 10 credit notes").
--
-- - `einvoice_chain_checks` (TENANT) — one verdict per organization per nightly run of the worker's
--   chain reconciler (`apps/worker/src/jobs/einvoice-chain-reconciler.ts`, 03:00 UTC). The walk
--   reads `zatca_icv`, `zatca_pih` and `zatca_xml_hash` of `client_invoices` and
--   `client_credit_notes` (0311, one chain across both tables) in ICV order and checks link
--   integrity only: icv 1 carries the genesis PIH (SHA-256 of '0'), every next icv is previous + 1,
--   every PIH equals the previous document's XML hash, no two documents share an XML hash. The XML
--   rebuild-and-compare stays the per-document `hashMatches` of the API's einvoice route.
--   `status` ok | broken | empty; `break_reason` gap | pih_mismatch | genesis_mismatch |
--   duplicate_hash (closed lists checked in the worker). `detail_json` holds counts only — never a
--   hash, never an amount. A break also raises a `security_signals` row (`einvoice_chain_break`).
--   The worker prunes verdicts older than 90 days; nothing ever UPDATEs a verdict.
--
-- MariaDB-safe (Hostinger): VARCHAR instead of ENUM, no CHECK, no generated column, no JSON type,
-- no IF NOT EXISTS, DATETIME(3), utf8mb4_unicode_ci. Additive only.
-- Registry: schema.ts (`einvoiceChainChecks`, TABLES, `EinvoiceChainCheckRow`), tenant-guard
-- `TENANT_TABLES`, scripts/db/users.sql (R22-b block); the migrator is directory-driven.

CREATE TABLE einvoice_chain_checks (
  id              CHAR(36)      NOT NULL,
  organization_id CHAR(36)      NOT NULL,
  checked_at      DATETIME(3)   NOT NULL,
  status          VARCHAR(16)   NOT NULL,
  head_icv        INT UNSIGNED  NULL,
  documents       INT UNSIGNED  NOT NULL DEFAULT 0,
  break_icv       INT UNSIGNED  NULL,
  break_reason    VARCHAR(32)   NULL,
  detail_json     TEXT          NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ecc_org_id (organization_id, id),
  KEY ix_ecc_org_checked (organization_id, checked_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
