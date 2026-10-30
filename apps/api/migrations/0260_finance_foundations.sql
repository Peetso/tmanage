-- 0260_finance_foundations — money foundations: finance profile, tax rates, gapless document
-- sequences, manual exchange rates (52-23 backend half; spec 52 §4).
--
-- ## What this migration is for
--
-- Every money item (invoices, credit notes, retainers, the ZATCA path) needs one profile per
-- organization, a list of tax rates, a numbering counter and dated manual FX rates. Four TENANT
-- tables:
--
-- - `org_finance_profiles` — one row per organization (`uq_ofp_org`). Country, base currency, tax
--   registration number, default tax rate in basis points (1500 = 15 %), legal names and address
--   in EN and AR, document prefixes, `numbering_reset` (yearly | never), `digits` (latn | arab),
--   payment terms. Internal: never part of a client projection. Closed lists are checked in the
--   application. Absent until the first save; the API answers defaults until then.
-- - `org_tax_rates` — several rates per organization, unique by `code`. Seeded in code (not here)
--   on the first read: STD (country default), ZERO, EXEMPT, OOS, with Arabic names.
--   `zatca_category` is S | Z | E | O or NULL. Archived, never deleted (a document keeps its rate).
-- - `org_document_sequences` — one counter per organization, document kind (invoice | quote |
--   credit_note) and period (`2026`, or `0000` when the profile never resets). The issuing
--   transaction locks the row FOR UPDATE, takes `next_value` and advances it, so numbers are
--   gapless and never repeat.
-- - `org_exchange_rates` — manual dated rates; one per pair per day. DECIMAL(18,8).
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, closed lists checked in the application, DATETIME(3)/DATE, no generated columns,
-- no CHECK, no JSON defaults, no functional indexes, no foreign keys (the 0257 convention),
-- utf8mb4_unicode_ci. Additive only: four new tables.

CREATE TABLE org_finance_profiles (
  id                   CHAR(36)      NOT NULL,
  organization_id      CHAR(36)      NOT NULL,
  country              CHAR(2)       NOT NULL,
  base_currency        CHAR(3)       NOT NULL,
  tax_registration_no  VARCHAR(32)   NULL,
  tax_scheme           VARCHAR(16)   NOT NULL DEFAULT 'VAT',
  default_tax_rate_bp  INT           NOT NULL DEFAULT 0,
  legal_name_en        VARCHAR(200)  NULL,
  legal_name_ar        VARCHAR(200)  NULL,
  address_en           VARCHAR(500)  NULL,
  address_ar           VARCHAR(500)  NULL,
  invoice_prefix       VARCHAR(16)   NOT NULL DEFAULT 'INV',
  quote_prefix         VARCHAR(16)   NOT NULL DEFAULT 'QT',
  credit_note_prefix   VARCHAR(16)   NOT NULL DEFAULT 'CN',
  numbering_reset      VARCHAR(8)    NOT NULL DEFAULT 'yearly',
  rounding_minutes     INT           NOT NULL DEFAULT 15,
  week_start           TINYINT       NOT NULL DEFAULT 0,
  digits               VARCHAR(8)    NOT NULL DEFAULT 'latn',
  show_hijri           TINYINT(1)    NOT NULL DEFAULT 0,
  bank_details_text    TEXT          NULL,
  payment_terms_days   INT           NOT NULL DEFAULT 30,
  version              INT           NOT NULL DEFAULT 1,
  created_at           DATETIME(3)   NOT NULL,
  updated_at           DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ofp_org_id (organization_id, id),
  UNIQUE KEY uq_ofp_org (organization_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE org_tax_rates (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  code             VARCHAR(16)  NOT NULL,
  name_en          VARCHAR(64)  NOT NULL,
  name_ar          VARCHAR(64)  NOT NULL,
  rate_bp          INT          NOT NULL,
  zatca_category   VARCHAR(4)   NULL,
  is_default       TINYINT(1)   NOT NULL DEFAULT 0,
  archived_at      DATETIME(3)  NULL,
  created_at       DATETIME(3)  NOT NULL,
  updated_at       DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_otr_org_id (organization_id, id),
  UNIQUE KEY uq_otr_org_code (organization_id, code)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE org_document_sequences (
  id               CHAR(36)     NOT NULL,
  organization_id  CHAR(36)     NOT NULL,
  kind             VARCHAR(16)  NOT NULL,
  period_key       CHAR(4)      NOT NULL,
  next_value       INT          NOT NULL DEFAULT 1,
  created_at       DATETIME(3)  NOT NULL,
  updated_at       DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ods_org_id (organization_id, id),
  UNIQUE KEY uq_ods_key (organization_id, kind, period_key)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE org_exchange_rates (
  id               CHAR(36)       NOT NULL,
  organization_id  CHAR(36)       NOT NULL,
  from_currency    CHAR(3)        NOT NULL,
  to_currency      CHAR(3)        NOT NULL,
  rate             DECIMAL(18,8)  NOT NULL,
  effective_on     DATE           NOT NULL,
  source           VARCHAR(32)    NOT NULL DEFAULT 'manual',
  created_by       CHAR(36)       NOT NULL,
  created_at       DATETIME(3)    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_oer_org_id (organization_id, id),
  UNIQUE KEY uq_oer_pair_day (organization_id, from_currency, to_currency, effective_on)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
