-- 0259_quotes — quotes and their lines, with an accept link (52-08 backend half; spec 52 §52-08).
--
-- ## What this migration is for
--
-- An agency builds a quote (a number, a client or lead, a currency, lines, server-computed
-- totals), sends it, and the client accepts or declines it through a 56-07 public link of kind
-- `quote`. Two TENANT tables:
--
-- - `quotes` — one quote. `status` is a closed list checked in the application (draft, sent,
--   accepted, declined, expired). `seq` is the per-organization counter behind `number`
--   (`Q-0001`). Every amount is an integer in minor units, computed by the server from the lines;
--   a client never sends a total. `content_hash` (SHA-256 of the canonical content) is written
--   when the quote is sent: a sent quote is immutable and its accept link binds that hash.
--   `notes_text` is internal and never reaches the public projection.
-- - `quote_lines` — the lines of one quote, in `position` order. Replaced as a set while the
--   quote is a draft; never touched once it is sent. `quantity_centi` is the quantity in
--   hundredths (150 = 1.5 hours), so a line total is exact integer arithmetic.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, closed lists checked in the application, DATETIME(3), no generated columns, no
-- CHECK, no functional indexes, no foreign keys (the 0257 convention), utf8mb4_unicode_ci.
-- Additive only: two new tables.

CREATE TABLE quotes (
  id                     CHAR(36)      NOT NULL,
  organization_id        CHAR(36)      NOT NULL,
  seq                    INT           NOT NULL,
  number                 VARCHAR(32)   NOT NULL,
  client_organization_id CHAR(36)      NULL,
  lead_name              VARCHAR(200)  NULL,
  lead_email             VARCHAR(320)  NULL,
  title                  VARCHAR(200)  NOT NULL,
  language               VARCHAR(5)    NOT NULL DEFAULT 'en',
  currency               CHAR(3)       NOT NULL,
  status                 VARCHAR(16)   NOT NULL DEFAULT 'draft',
  valid_until            DATETIME(3)   NOT NULL,
  subtotal_minor         BIGINT        NOT NULL DEFAULT 0,
  tax_minor              BIGINT        NOT NULL DEFAULT 0,
  total_minor            BIGINT        NOT NULL DEFAULT 0,
  terms_text             TEXT          NULL,
  notes_text             TEXT          NULL,
  content_hash           CHAR(64)      NULL,
  sent_at                DATETIME(3)   NULL,
  sent_link_id           CHAR(36)      NULL,
  decided_at             DATETIME(3)   NULL,
  created_by_user_id     CHAR(36)      NULL,
  version                INT           NOT NULL DEFAULT 1,
  created_at             DATETIME(3)   NOT NULL,
  updated_at             DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_quotes_org_id (organization_id, id),
  UNIQUE KEY uq_quotes_org_number (organization_id, number),
  UNIQUE KEY uq_quotes_org_seq (organization_id, seq),
  KEY ix_quotes_org_status (organization_id, status, created_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE quote_lines (
  id                CHAR(36)      NOT NULL,
  organization_id   CHAR(36)      NOT NULL,
  quote_id          CHAR(36)      NOT NULL,
  position          INT           NOT NULL,
  description       VARCHAR(500)  NOT NULL,
  unit              VARCHAR(12)   NOT NULL DEFAULT 'item',
  quantity_centi    INT           NOT NULL,
  unit_price_minor  BIGINT        NOT NULL,
  tax_bp            INT           NOT NULL DEFAULT 0,
  line_net_minor    BIGINT        NOT NULL,
  line_tax_minor    BIGINT        NOT NULL,
  created_at        DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_quote_lines_org_id (organization_id, id),
  KEY ix_quote_lines_quote (organization_id, quote_id, position)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
