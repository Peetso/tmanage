-- 0366_mail_recipient_bounces — mail bounce handling (56-26).
--
-- ## What this migration is for
--
-- When a company's mail bounces, the bounce (an RFC 3464 delivery report) is posted to the signed
-- intake `POST /v1/public/inbound-email/bounces`. The report quotes the original Message-ID, which
-- TManage signed when it sent the mail (`packages/mail/src/bounce-id.ts`): the id alone names the
-- company and the recipient's address hash. One row here per (company, address) that bounced:
--
-- - `hard_count` / `soft_count`: bounces counted, one per message (`last_message_ref` is the
--   signed id's nonce, so a report delivered twice counts once; a hard report for a message that
--   already bounced soft is counted as the hard one).
-- - `suppressed_at`: set by the first hard bounce, or by the third soft bounce within 30 days
--   (older soft bounces start the count again). While set, the company's mail to that address is
--   held back (`BounceGuardMailer`); sign-in and password mail never is.
-- - `cleared_at` / `cleared_by_user_id`: an owner or admin cleared the suppression; the counts
--   start again from zero.
--
-- `address_hash` is the base64url SHA-256 of the trimmed, lower-cased address (`emailAddressHash`,
-- the same key `email_suppressions` uses): the raw address is never stored. An admin checks or
-- clears an address by typing it; the API hashes it.
--
-- TENANT (`organization_id`), primary key (organization_id, address_hash). The API inserts and
-- updates; no DELETE at runtime (the company erasure empties it with every other tenant table).
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns with literal defaults, DATETIME(3), VARCHAR vocabularies checked in code, no
-- CHECK, no generated column, no functional or partial index, no trigger. Additive only.

CREATE TABLE mail_recipient_bounces (
  organization_id    CHAR(36)      NOT NULL,
  address_hash       VARCHAR(64)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  hard_count         INT UNSIGNED  NOT NULL DEFAULT 0,
  soft_count         INT UNSIGNED  NOT NULL DEFAULT 0,
  last_kind          VARCHAR(8)    NOT NULL,
  last_status        VARCHAR(16)   NOT NULL,
  last_message_ref   VARCHAR(32)   CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  last_bounced_at    DATETIME(3)   NOT NULL,
  suppressed_at      DATETIME(3)   NULL,
  cleared_at         DATETIME(3)   NULL,
  cleared_by_user_id CHAR(36)      NULL,
  created_at         DATETIME(3)   NOT NULL,
  updated_at         DATETIME(3)   NOT NULL,
  PRIMARY KEY (organization_id, address_hash),
  KEY ix_mail_recipient_bounces_org_suppressed (organization_id, suppressed_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
