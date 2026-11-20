-- 0388_walkthrough_requests — "Book a walkthrough" requests from the public site (LANE-Q).
--
-- ## What this migration is for
--
-- The public page `/walkthrough` (and `/ar/walkthrough`) asks a visitor for a name, a work e-mail,
-- the company, the team size, three preferred times in the visitor's own time zone and the topics
-- for the call (a tour, why switch from the current tool, future features), plus consent to be
-- answered by e-mail. `POST /v1/public/walkthrough-requests` stores one row here and mails the
-- sales team from sales@ (template `walkthrough_request`, through the API's mail stack: the
-- mail_queue outbox when MAIL_QUEUE=on). The visitor is answered by a person, by hand.
--
-- - `walkthrough_requests` (GLOBAL, no organization_id: a visitor belongs to no company yet; in
--   NON_TENANT_TABLES). `email_enc` is a 56-02 FieldCipher envelope (purpose
--   `walkthrough_email`, owner = row id) or NULL on a keyless host: the address is never stored
--   in plain text. `slots` holds the three times as `YYYY-MM-DDTHH:MM` wall-clock values in
--   `time_zone` (an IANA name), comma-separated; `topics` the chosen keys (`tour`, `switch`,
--   `future`), comma-separated. `consent_at` is when the visitor ticked the consent line.
--   `risk_decision` is 52-21's verdict (`allow` or `hold`); a held request is stored and not
--   mailed. `notified_at` is set when sales@ accepted the notification.
--
-- Grants (scripts/db/users.sql 0388 block): app INSERT, UPDATE (notified_at); SELECT rides the
-- database-wide read. No DELETE at runtime.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATETIME(3), VARCHAR vocabularies checked in code, no CHECK, no generated
-- column, no JSON column, no functional or partial index, no trigger, no foreign key. One CREATE;
-- the migrator treats "already exists" on a re-run as applied (DA-8).

CREATE TABLE walkthrough_requests (
  id            CHAR(36)     NOT NULL,
  reference     VARCHAR(16)  NOT NULL,
  name          VARCHAR(120) NOT NULL,
  email_enc     VARCHAR(600) NULL,
  company       VARCHAR(160) NOT NULL,
  team_size     VARCHAR(16)  NOT NULL,
  time_zone     VARCHAR(64)  NOT NULL,
  slots         VARCHAR(80)  NOT NULL,
  topics        VARCHAR(40)  NOT NULL,
  language      VARCHAR(8)   NOT NULL DEFAULT 'en',
  source        VARCHAR(32)  NULL,
  risk_decision VARCHAR(16)  NOT NULL DEFAULT 'allow',
  consent_at    DATETIME(3)  NOT NULL,
  notified_at   DATETIME(3)  NULL,
  created_at    DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_walkthrough_requests_reference (reference),
  KEY ix_walkthrough_requests_created (created_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
