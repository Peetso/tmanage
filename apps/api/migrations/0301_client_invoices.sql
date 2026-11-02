-- 0301_client_invoices — 52-09 client invoices, core (R18 slice a).
--
-- ## What this migration is for
--
-- An agency invoices its client: approved time, approved billable expenses, a retainer fee or the
-- fixed lines of an accepted quote are pulled into a draft, the draft is sent (numbered, frozen,
-- hashed), payments are recorded against it, and a mistake is corrected by a credit note — never by
-- editing a sent invoice. Names carry the `client_` prefix so they never collide with `billing/*`
-- (TManage's own subscription invoices).
--
-- - `client_invoices` (TENANT, new) — the header. `kind` ('standard' | 'simplified' | 'deposit' |
--   'final'), `language` ('en' | 'ar' | 'bi') and `state` ('draft' | 'sent' | 'partially_paid' |
--   'paid' | 'void' | 'credited') are closed lists checked in the application (VARCHAR, not ENUM).
--   `number` is NULL while draft and assigned at send from `org_document_sequences` inside the
--   sending transaction; `uq_ci_number` keeps it unique (NULLs do not collide). Totals are
--   computed by the server only. `buyer_snapshot_json` / `seller_snapshot_json` are immutable
--   copies taken at send; `content_hash` is the canonical hash at send. `send_key_hash` is the
--   SHA-256 of the `Idempotency-Key` the send carried, so a retry answers the same response.
--   `document_label` is reserved for 52-28 (always 'invoice' here). `pdf_*` / `xml_*` are reserved
--   for 52-10 / ZATCA; `exported_*` for 52-11.
-- - `client_invoice_lines` (TENANT, new) — `source_type` ('time' | 'expense' | 'retainer' |
--   'quote' | 'manual'); `quantity_centi` is hundredths (150 = 1.5); line amounts are server-
--   computed; `source_ids_json` lists the time-log / expense / retainer-period ids a pulled line
--   stands for, linked at send (`work_item_time_logs.invoice_line_id`, `expenses.invoice_line_id`,
--   `retainer_periods.invoice_id`). A draft re-pull deletes and re-inserts its pulled lines.
-- - `client_invoice_payments` (TENANT, new) — `method` ('transfer' | 'cash' | 'cheque' |
--   'card_offline'). Append-only.
-- - `client_credit_notes` / `client_credit_note_lines` (TENANT, new) — a credit note with its own
--   gapless number (`nextNumber('credit_note')`). Append-only.
-- - `client_invoice_events` (TENANT, new) — the invoice timeline: created, sent, viewed,
--   reminder_sent, payment_recorded, voided, credited, exported. `actor_kind` ('member' | 'client' |
--   'system'). Append-only.
-- - `client_organizations` gains eight NULL billing columns (legal names, tax number, billing
--   addresses, billing e-mail, default currency, payment terms).
--
-- ## Immutability at the engine
--
-- `trg_client_invoices_sent_immutable` refuses, once `OLD.state <> 'draft'`, any change to the
-- money, the currency and rate, the dates, the client and the number: after send only `state`,
-- `paid_minor`, `paid_at`, `viewed_at`, `exported_*`, `pdf_*`, `xml_*`, `version` and `updated_at`
-- move. `trg_client_invoice_lines_sent_immutable_*` refuse an UPDATE or DELETE of a line whose
-- invoice is no longer a draft (the parent's state is read inside the trigger). The 0265
-- `trg_work_item_time_logs_immutable` is replaced (end of file) so a locked entry may take its
-- `invoice_line_id` and nothing else.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATE / DATETIME(3), composite tenant keys, no generated columns, no CHECK, no JSON
-- column type (TEXT), utf8mb4_unicode_ci — the 0283 / 0291 / 0299 conventions.
--
-- ## Grants (scripts/db/users.sql, 0301 block)
--
-- `tmanage_app`: SELECT, INSERT, UPDATE on `client_invoices`, `client_credit_notes`; SELECT, INSERT,
-- UPDATE, DELETE on `client_invoice_lines`; SELECT, INSERT on `client_invoice_payments`,
-- `client_credit_note_lines`, `client_invoice_events`; UPDATE on `work_item_time_logs`, `expenses`,
-- `retainer_periods` restated (the line links). `tmanage_worker`: nothing.

ALTER TABLE client_organizations
  ADD COLUMN legal_name_en       VARCHAR(200) NULL,
  ADD COLUMN legal_name_ar       VARCHAR(200) NULL,
  ADD COLUMN tax_registration_no VARCHAR(32)  NULL,
  ADD COLUMN billing_address_en  VARCHAR(500) NULL,
  ADD COLUMN billing_address_ar  VARCHAR(500) NULL,
  ADD COLUMN billing_email       VARCHAR(254) NULL,
  ADD COLUMN default_currency    CHAR(3)      NULL,
  ADD COLUMN payment_terms_days  INT          NULL;

CREATE TABLE client_invoices (
  id                      CHAR(36)        NOT NULL,
  organization_id         CHAR(36)        NOT NULL,
  client_organization_id  CHAR(36)        NOT NULL,
  project_id              CHAR(36)        NULL,
  retainer_period_id      CHAR(36)        NULL,
  quote_id                CHAR(36)        NULL,
  -- NULL while draft; assigned at send.
  number                  VARCHAR(32)     NULL,
  -- 'standard' | 'simplified' | 'deposit' | 'final' (checked in the application).
  kind                    VARCHAR(16)     NOT NULL DEFAULT 'standard',
  -- 'en' | 'ar' | 'bi' (checked in the application).
  language                VARCHAR(2)      NOT NULL DEFAULT 'bi',
  -- 'draft' | 'sent' | 'partially_paid' | 'paid' | 'void' | 'credited' (checked in the application).
  state                   VARCHAR(16)     NOT NULL DEFAULT 'draft',
  -- Reserved for 52-28.
  document_label          VARCHAR(16)     NOT NULL DEFAULT 'invoice',
  issue_date              DATE            NULL,
  due_date                DATE            NULL,
  supply_date             DATE            NULL,
  period_start            DATE            NULL,
  period_end              DATE            NULL,
  currency                CHAR(3)         NOT NULL,
  base_currency           CHAR(3)         NOT NULL,
  fx_rate                 DECIMAL(18,8)   NULL,
  subtotal_minor          BIGINT          NOT NULL DEFAULT 0,
  discount_minor          BIGINT          NOT NULL DEFAULT 0,
  tax_minor               BIGINT          NOT NULL DEFAULT 0,
  total_minor             BIGINT          NOT NULL DEFAULT 0,
  paid_minor              BIGINT          NOT NULL DEFAULT 0,
  deposit_applied_minor   BIGINT          NOT NULL DEFAULT 0,
  po_number               VARCHAR(64)     NULL,
  notes_text              TEXT            NULL,
  internal_note           TEXT            NULL,
  terms_text              TEXT            NULL,
  buyer_snapshot_json     TEXT            NULL,
  seller_snapshot_json    TEXT            NULL,
  content_hash            CHAR(64)        NULL,
  send_key_hash           CHAR(64)        NULL,
  pdf_file_asset_id       CHAR(36)        NULL,
  pdf_file_version_id     CHAR(36)        NULL,
  xml_file_asset_id       CHAR(36)        NULL,
  sent_at                 DATETIME(3)     NULL,
  sent_to                 VARCHAR(254)    NULL,
  viewed_at               DATETIME(3)     NULL,
  paid_at                 DATETIME(3)     NULL,
  voided_at               DATETIME(3)     NULL,
  void_reason             VARCHAR(500)    NULL,
  exported_at             DATETIME(3)     NULL,
  export_target           VARCHAR(24)     NULL,
  created_by              CHAR(36)        NOT NULL,
  version                 BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at              DATETIME(3)     NOT NULL,
  updated_at              DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ci_org_id (organization_id, id),
  UNIQUE KEY uq_ci_number (organization_id, number),
  KEY ix_ci_client_state (organization_id, client_organization_id, state, issue_date),
  KEY ix_ci_due (organization_id, state, due_date),
  CONSTRAINT fk_ci_client_tenant
    FOREIGN KEY (organization_id, client_organization_id)
    REFERENCES client_organizations (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE client_invoice_lines (
  id                 CHAR(36)      NOT NULL,
  organization_id    CHAR(36)      NOT NULL,
  invoice_id         CHAR(36)      NOT NULL,
  position           INT           NOT NULL,
  -- 'time' | 'expense' | 'retainer' | 'quote' | 'manual' (checked in the application).
  source_type        VARCHAR(16)   NOT NULL DEFAULT 'manual',
  description_en     VARCHAR(500)  NULL,
  description_ar     VARCHAR(500)  NULL,
  quantity_centi     INT           NOT NULL,
  unit               VARCHAR(12)   NOT NULL DEFAULT 'item',
  unit_price_minor   BIGINT        NOT NULL,
  discount_bp        INT           NOT NULL DEFAULT 0,
  tax_rate_id        CHAR(36)      NULL,
  tax_bp             INT           NOT NULL DEFAULT 0,
  tax_category       VARCHAR(4)    NULL,
  line_discount_minor BIGINT       NOT NULL DEFAULT 0,
  line_net_minor     BIGINT        NOT NULL,
  line_tax_minor     BIGINT        NOT NULL,
  line_gross_minor   BIGINT        NOT NULL,
  group_key          VARCHAR(64)   NULL,
  source_ids_json    TEXT          NULL,
  created_at         DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cil_org_id (organization_id, id),
  KEY ix_cil_invoice (organization_id, invoice_id, position),
  CONSTRAINT fk_cil_invoice_tenant
    FOREIGN KEY (organization_id, invoice_id) REFERENCES client_invoices (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE client_invoice_payments (
  id               CHAR(36)      NOT NULL,
  organization_id  CHAR(36)      NOT NULL,
  invoice_id       CHAR(36)      NOT NULL,
  paid_on          DATE          NOT NULL,
  amount_minor     BIGINT        NOT NULL,
  currency         CHAR(3)       NOT NULL,
  -- 'transfer' | 'cash' | 'cheque' | 'card_offline' (checked in the application).
  method           VARCHAR(16)   NOT NULL,
  reference        VARCHAR(120)  NULL,
  note             VARCHAR(500)  NULL,
  recorded_by      CHAR(36)      NOT NULL,
  created_at       DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cip_org_id (organization_id, id),
  KEY ix_cip_invoice (organization_id, invoice_id, paid_on),
  CONSTRAINT fk_cip_invoice_tenant
    FOREIGN KEY (organization_id, invoice_id) REFERENCES client_invoices (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE client_credit_notes (
  id                 CHAR(36)      NOT NULL,
  organization_id    CHAR(36)      NOT NULL,
  invoice_id         CHAR(36)      NOT NULL,
  number             VARCHAR(32)   NOT NULL,
  reason             VARCHAR(500)  NOT NULL,
  subtotal_minor     BIGINT        NOT NULL,
  tax_minor          BIGINT        NOT NULL,
  total_minor        BIGINT        NOT NULL,
  content_hash       CHAR(64)      NOT NULL,
  pdf_file_asset_id  CHAR(36)      NULL,
  xml_file_asset_id  CHAR(36)      NULL,
  issued_at          DATETIME(3)   NOT NULL,
  created_by         CHAR(36)      NOT NULL,
  created_at         DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ccn_org_id (organization_id, id),
  UNIQUE KEY uq_ccn_number (organization_id, number),
  KEY ix_ccn_invoice (organization_id, invoice_id),
  CONSTRAINT fk_ccn_invoice_tenant
    FOREIGN KEY (organization_id, invoice_id) REFERENCES client_invoices (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE client_credit_note_lines (
  id                 CHAR(36)      NOT NULL,
  organization_id    CHAR(36)      NOT NULL,
  credit_note_id     CHAR(36)      NOT NULL,
  position           INT           NOT NULL,
  description_en     VARCHAR(500)  NULL,
  description_ar     VARCHAR(500)  NULL,
  quantity_centi     INT           NOT NULL,
  unit               VARCHAR(12)   NOT NULL DEFAULT 'item',
  unit_price_minor   BIGINT        NOT NULL,
  tax_bp             INT           NOT NULL DEFAULT 0,
  line_net_minor     BIGINT        NOT NULL,
  line_tax_minor     BIGINT        NOT NULL,
  line_gross_minor   BIGINT        NOT NULL,
  created_at         DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ccnl_org_id (organization_id, id),
  KEY ix_ccnl_note (organization_id, credit_note_id, position),
  CONSTRAINT fk_ccnl_note_tenant
    FOREIGN KEY (organization_id, credit_note_id) REFERENCES client_credit_notes (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE client_invoice_events (
  id               CHAR(36)      NOT NULL,
  organization_id  CHAR(36)      NOT NULL,
  invoice_id       CHAR(36)      NOT NULL,
  -- created | sent | viewed | reminder_sent | payment_recorded | voided | credited | exported.
  kind             VARCHAR(24)   NOT NULL,
  -- 'member' | 'client' | 'system' (checked in the application).
  actor_kind       VARCHAR(8)    NOT NULL,
  actor_id         CHAR(36)      NULL,
  ip               VARCHAR(45)   NULL,
  ua               VARCHAR(255)  NULL,
  payload_json     TEXT          NULL,
  created_at       DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cie_org_id (organization_id, id),
  KEY ix_cie_invoice (organization_id, invoice_id, kind, created_at),
  CONSTRAINT fk_cie_invoice_tenant
    FOREIGN KEY (organization_id, invoice_id) REFERENCES client_invoices (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

-- organization_id is immutable on all six (ADR-0001 layer 1), as on every tenant table.
CREATE TRIGGER trg_client_invoices_org_immutable
BEFORE UPDATE ON client_invoices FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_invoices.organization_id is immutable';
  END IF;
END$$

CREATE TRIGGER trg_client_invoice_lines_org_immutable
BEFORE UPDATE ON client_invoice_lines FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_invoice_lines.organization_id is immutable';
  END IF;
END$$

CREATE TRIGGER trg_client_invoice_payments_org_immutable
BEFORE UPDATE ON client_invoice_payments FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_invoice_payments.organization_id is immutable';
  END IF;
END$$

CREATE TRIGGER trg_client_credit_notes_org_immutable
BEFORE UPDATE ON client_credit_notes FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_credit_notes.organization_id is immutable';
  END IF;
END$$

CREATE TRIGGER trg_client_credit_note_lines_org_immutable
BEFORE UPDATE ON client_credit_note_lines FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_credit_note_lines.organization_id is immutable';
  END IF;
END$$

CREATE TRIGGER trg_client_invoice_events_org_immutable
BEFORE UPDATE ON client_invoice_events FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_invoice_events.organization_id is immutable';
  END IF;
END$$

-- A sent invoice keeps its money, currency, rate, dates, client and number.
CREATE TRIGGER trg_client_invoices_sent_immutable
BEFORE UPDATE ON client_invoices FOR EACH ROW
BEGIN
  IF OLD.state <> 'draft' AND (
       NOT (NEW.subtotal_minor <=> OLD.subtotal_minor)
       OR NOT (NEW.discount_minor <=> OLD.discount_minor)
       OR NOT (NEW.tax_minor <=> OLD.tax_minor)
       OR NOT (NEW.total_minor <=> OLD.total_minor)
       OR NOT (NEW.deposit_applied_minor <=> OLD.deposit_applied_minor)
       OR NOT (NEW.currency <=> OLD.currency)
       OR NOT (NEW.fx_rate <=> OLD.fx_rate)
       OR NOT (NEW.issue_date <=> OLD.issue_date)
       OR NOT (NEW.due_date <=> OLD.due_date)
       OR NOT (NEW.client_organization_id <=> OLD.client_organization_id)
       OR NOT (NEW.number <=> OLD.number)
       OR NOT (NEW.content_hash <=> OLD.content_hash)
       OR NOT (NEW.buyer_snapshot_json <=> OLD.buyer_snapshot_json)
       OR NOT (NEW.seller_snapshot_json <=> OLD.seller_snapshot_json)) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_invoices row is sent';
  END IF;
END$$

-- A line of a sent invoice is never changed or removed.
CREATE TRIGGER trg_client_invoice_lines_sent_immutable_upd
BEFORE UPDATE ON client_invoice_lines FOR EACH ROW
BEGIN
  DECLARE parent_state VARCHAR(16);
  SELECT state INTO parent_state FROM client_invoices
   WHERE organization_id = OLD.organization_id AND id = OLD.invoice_id;
  IF parent_state IS NULL OR parent_state <> 'draft' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_invoice_lines row is sent';
  END IF;
END$$

CREATE TRIGGER trg_client_invoice_lines_sent_immutable_del
BEFORE DELETE ON client_invoice_lines FOR EACH ROW
BEGIN
  DECLARE parent_state VARCHAR(16);
  SELECT state INTO parent_state FROM client_invoices
   WHERE organization_id = OLD.organization_id AND id = OLD.invoice_id;
  IF parent_state IS NULL OR parent_state <> 'draft' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_invoice_lines row is sent';
  END IF;
END$$

DELIMITER ;

-- Replace the 0265 time-log trigger so the send can link a LOCKED entry to its invoice line.
-- Approved time sits in 52-03 locked periods, and 0265 refused every update of a locked row except
-- the unlock. Everything 0265 held still holds — identity, and every data column of a locked entry
-- — and the 52-04 snapshots and the 0299 reserved column are now named explicitly; the one column a
-- locked entry may still move is `invoice_line_id` (written by the send, cleared by a void).
DROP TRIGGER IF EXISTS trg_work_item_time_logs_immutable;

DELIMITER $$

CREATE TRIGGER trg_work_item_time_logs_immutable
BEFORE UPDATE ON work_item_time_logs FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_time_logs.organization_id is immutable';
  END IF;
  IF NEW.logged_by <> OLD.logged_by THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_time_logs.logged_by is immutable';
  END IF;
  IF OLD.work_item_id IS NOT NULL AND NOT (NEW.work_item_id <=> OLD.work_item_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_item_time_logs.work_item_id is immutable';
  END IF;
  IF OLD.locked_at IS NOT NULL THEN
    IF (NEW.locked_at IS NOT NULL AND NOT (NEW.locked_at <=> OLD.locked_at))
       OR NEW.minutes <> OLD.minutes
       OR NEW.spent_on <> OLD.spent_on
       OR NOT (NEW.started_at <=> OLD.started_at)
       OR NOT (NEW.ended_at <=> OLD.ended_at)
       OR NEW.billable <> OLD.billable
       OR NOT (NEW.note <=> OLD.note)
       OR NOT (NEW.work_item_id <=> OLD.work_item_id)
       OR NOT (NEW.project_id <=> OLD.project_id)
       OR NOT (NEW.timesheet_id <=> OLD.timesheet_id)
       OR NOT (NEW.rate_snapshot_minor <=> OLD.rate_snapshot_minor)
       OR NOT (NEW.cost_snapshot_minor <=> OLD.cost_snapshot_minor)
       OR NOT (NEW.snapshot_currency <=> OLD.snapshot_currency)
       OR NOT (NEW.retainer_period_id <=> OLD.retainer_period_id) THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'work_item_time_logs row is locked';
    END IF;
  END IF;
END$$

DELIMITER ;
