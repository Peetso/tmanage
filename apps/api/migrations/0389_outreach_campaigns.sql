-- 0389_outreach_campaigns — the owner-approved outreach campaign and its recipients (LANE-Q).
--
-- ## What this migration is for
--
-- A platform admin imports the researched decision-makers list (Platform admin -> Outreach); the
-- importer keeps only the rows that may be written to (see `outreach/outreach-import.ts`) and
-- stores them here. The worker's `campaign-sender` job then sends each recipient one plain-text
-- introduction from a named teammate's own mailbox (ADR-0013), at the agreed pace, inside the
-- recipient's local working hours, and never to a suppressed or bounced address. Each mail
-- carries a personal trial link (`packages/mail/src/trial-link.ts`); the sign-up that redeems it
-- stamps the recipient row, once.
--
-- - `outreach_campaigns` (GLOBAL, platform table, in NON_TENANT_TABLES). `status` is `paused`
--   (every campaign is created paused), `running` or `stopped` (final). `first_started_at` is the
--   first start: the pace's day count runs from it (5 a day per mailbox in week 1, 10 in week 2,
--   then 20, never more). Only platform admins change it, every change audited.
-- - `outreach_recipients` (GLOBAL, in NON_TENANT_TABLES): one person at one company. The address
--   is a 56-02 FieldCipher envelope (`email_enc`, purpose `outreach_email`, owner = row id), never
--   plain text; `email_hash` is base64url SHA-256 of the lower-cased address, the same key the
--   unsubscribe list (`email_suppressions`) uses, and is UNIQUE: nobody is imported twice, in any
--   campaign. `sender_person_id` names the `platform_mail_people` row that signs and sends.
--   `status`: `queued`, `sending` (claimed by one worker pass, `sent_at` = the claim; a pass that
--   dies mid-send leaves it here and it is never sent twice), `sent`, `failed` (the mailbox
--   refused it; not retried in v1),
--   `suppressed` (unsubscribed or bounced before the send) or `bounced` (marked after the send).
--   `trial_redeemed_at` / `trial_user_id` are set by the sign-up that used the personal trial
--   link (compare-and-set on `trial_redeemed_at IS NULL`, inside the account transaction).
--
-- Grants (scripts/db/users.sql 0389 block): app INSERT, UPDATE on both (import, start/pause/stop,
-- mark bounced, trial redemption); SELECT rides the database-wide read. Worker SELECT on the
-- campaign, SELECT, UPDATE on the recipients (claim, sent, failed, suppressed; key rotation).
-- No DELETE at runtime.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATETIME(3), VARCHAR vocabularies checked in code, no CHECK, no generated
-- column, no JSON column, no functional or partial index, no trigger, no foreign key. Two CREATEs;
-- the migrator treats "already exists" on a re-run as applied (DA-8).

CREATE TABLE outreach_campaigns (
  id                CHAR(36)     NOT NULL,
  name              VARCHAR(120) NOT NULL,
  status            VARCHAR(16)  NOT NULL DEFAULT 'paused',
  first_started_at  DATETIME(3)  NULL,
  created_by        CHAR(36)     NULL,
  created_at        DATETIME(3)  NOT NULL,
  updated_at        DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  KEY ix_outreach_campaigns_status (status)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE outreach_recipients (
  id                 CHAR(36)     NOT NULL,
  campaign_id        CHAR(36)     NOT NULL,
  company            VARCHAR(160) NOT NULL,
  person_name        VARCHAR(120) NOT NULL,
  first_name         VARCHAR(60)  NOT NULL,
  email_enc          VARCHAR(600) NOT NULL,
  email_hash         CHAR(43)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  country            CHAR(2)      CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  time_zone          VARCHAR(64)  NOT NULL,
  language           VARCHAR(8)   NOT NULL DEFAULT 'en',
  sender_person_id   CHAR(36)     NOT NULL,
  status             VARCHAR(16)  NOT NULL DEFAULT 'queued',
  sent_at            DATETIME(3)  NULL,
  last_error         VARCHAR(64)  NULL,
  trial_redeemed_at  DATETIME(3)  NULL,
  trial_user_id      CHAR(36)     NULL,
  created_at         DATETIME(3)  NOT NULL,
  updated_at         DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_outreach_recipients_email (email_hash),
  KEY ix_outreach_recipients_queue (campaign_id, status),
  KEY ix_outreach_recipients_sender (sender_person_id, sent_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
