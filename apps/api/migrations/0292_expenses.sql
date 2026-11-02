-- 0292_expenses — 52-07 Expenses, the backend half (R16 slice c).
--
-- ## What this migration is for
--
-- Agencies re-bill ad spend, stock, printing and travel. Until now nothing stored a cost that is not
-- an hour. One tenant table and one upload purpose:
--
-- - `expenses` (TENANT, new) — one spend by one member (`membership_id`, taken from the caller's
--   context, never from input) on one day, optionally on a project. `amount_minor` in `currency`;
--   `amount_base_minor` / `fx_rate` are the organization's base-currency value through the 52-23
--   manual exchange rate (NULL while no rate exists; submit then refuses). `state` is a closed list
--   checked in the application: draft | submitted | approved | rejected | invoiced | locked.
--   `approval_id` is reserved (the `approvals` table is deliverable-bound, 0027: expenses keep their
--   own approve / reject); `invoice_line_id` is reserved for 52-09; `locked_at` is set only by a
--   later 52-09 path. `receipt_file_asset_id` / `receipt_file_version_id` name an `expense_receipt`
--   upload of the submitter's; no foreign key to the files tables (the 0257 rule — the service
--   resolves them tenant-scoped). `client_organization_id` is the project's client at creation, no
--   foreign key. `(organization_id, project_id)` is bound to `projects (organization_id, id)`.
-- - Upload purpose `expense_receipt`: the two purpose ENUMs gain it at the end, so every stored value
--   keeps its position (as 0224 and 0232).
--
-- ## Triggers
--
-- - `trg_expenses_org_immutable` — `organization_id` and `membership_id` never move.
-- - `trg_expenses_locked_upd` — a locked row (`OLD.locked_at IS NOT NULL`) keeps its money, date,
--   project, billable flag, markup, tax, note, receipt and state; any change is SIGNAL 45000.
-- - `trg_expenses_locked_del` — a locked row is never deleted.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATE / DATETIME(3), composite tenant keys, no generated columns, no CHECK, no JSON,
-- no functional indexes, utf8mb4_unicode_ci; triggers in DELIMITER $$ blocks as 0283 / 0288. Two
-- BEFORE UPDATE triggers on one table are allowed on both engines.
--
-- ## Grants (scripts/db/users.sql, 0292 block)
--
-- `tmanage_app`: SELECT, INSERT, UPDATE, DELETE on `expenses` (DELETE: a member removes an own
-- draft). `tmanage_worker`: nothing.

CREATE TABLE expenses (
  id                       CHAR(36)       NOT NULL,
  organization_id          CHAR(36)       NOT NULL,
  project_id               CHAR(36)       NULL,
  client_organization_id   CHAR(36)       NULL,
  membership_id            CHAR(36)       NOT NULL,
  spent_on                 DATE           NOT NULL,
  -- Ads | Software | Travel | Print | Freelancer | Other (checked in the application).
  category                 VARCHAR(24)    NOT NULL,
  amount_minor             BIGINT         NOT NULL,
  currency                 CHAR(3)        NOT NULL,
  amount_base_minor        BIGINT         NULL,
  fx_rate                  DECIMAL(18,8)  NULL,
  tax_bp                   INT            NOT NULL DEFAULT 0,
  billable                 TINYINT(1)     NOT NULL DEFAULT 0,
  markup_bp                INT            NOT NULL DEFAULT 0,
  note                     VARCHAR(500)   NULL,
  receipt_file_asset_id    CHAR(36)       NULL,
  receipt_file_version_id  CHAR(36)       NULL,
  -- draft | submitted | approved | rejected | invoiced | locked (checked in the application).
  state                    VARCHAR(16)    NOT NULL DEFAULT 'submitted',
  -- Reserved: `approvals` is deliverable-bound (0027).
  approval_id              CHAR(36)       NULL,
  approved_by              CHAR(36)       NULL,
  approved_at              DATETIME(3)    NULL,
  rejected_reason          VARCHAR(500)   NULL,
  -- Reserved for 52-09.
  invoice_line_id          CHAR(36)       NULL,
  locked_at                DATETIME(3)    NULL,
  version                  INT UNSIGNED   NOT NULL DEFAULT 1,
  created_at               DATETIME(3)    NOT NULL,
  updated_at               DATETIME(3)    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_expenses_org_id (organization_id, id),
  KEY ix_expenses_project_day (organization_id, project_id, spent_on),
  KEY ix_expenses_member_state (organization_id, membership_id, state),
  KEY ix_expenses_receipt (organization_id, receipt_file_version_id),
  CONSTRAINT fk_expenses_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_expenses_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE file_assets
  MODIFY COLUMN purpose
    ENUM('message_attachment','request_attachment','deliverable','document','org_logo','request_message','expense_receipt') NOT NULL;

ALTER TABLE upload_sessions
  MODIFY COLUMN purpose
    ENUM('message_attachment','request_attachment','deliverable','document','org_logo','request_message','expense_receipt') NOT NULL;

DELIMITER $$

-- organization_id (ADR-0001 layer 1) and the submitter never move.
CREATE TRIGGER trg_expenses_org_immutable
BEFORE UPDATE ON expenses FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id)
     OR NOT (NEW.membership_id <=> OLD.membership_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'expenses.organization_id and membership_id are immutable';
  END IF;
END$$

CREATE TRIGGER trg_expenses_locked_upd
BEFORE UPDATE ON expenses FOR EACH ROW
BEGIN
  IF OLD.locked_at IS NOT NULL AND (
       NOT (NEW.amount_minor <=> OLD.amount_minor)
       OR NOT (NEW.currency <=> OLD.currency)
       OR NOT (NEW.spent_on <=> OLD.spent_on)
       OR NOT (NEW.project_id <=> OLD.project_id)
       OR NOT (NEW.billable <=> OLD.billable)
       OR NOT (NEW.markup_bp <=> OLD.markup_bp)
       OR NOT (NEW.tax_bp <=> OLD.tax_bp)
       OR NOT (NEW.note <=> OLD.note)
       OR NOT (NEW.receipt_file_asset_id <=> OLD.receipt_file_asset_id)
       OR NOT (NEW.state <=> OLD.state)) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'expenses row is locked';
  END IF;
END$$

CREATE TRIGGER trg_expenses_locked_del
BEFORE DELETE ON expenses FOR EACH ROW
BEGIN
  IF OLD.locked_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'expenses row is locked';
  END IF;
END$$

DELIMITER ;
