-- 0256_mail_queue — the transactional e-mail priority lane (56-31, spec 56 §12.1).
--
-- ## What this migration is for
--
-- Hostinger's hosting mail caps each mailbox per hour (§9.2). Until now every producer submitted
-- straight to SMTP and the in-process `SendCeilingMailer` (51-11) refused past an 80 % bulk share —
-- in memory, per process. With the queue, a producer enqueues one row and the worker drainer
-- (`apps/worker/src/jobs/mail-drainer.ts`) submits in lane order `auth → transactional → digest →
-- bulk` against a durable, shared hour window, so a sign-in code is never stuck behind a digest.
--
-- ## Tables
--
-- - `mail_queue` — one row per message. `lane` and `mailbox` are fixed in code (`laneForTemplate`
--   in `packages/mail/src/lanes.ts`), never taken from a request. `to_hash` is the SHA-256 (hex) of
--   the normalised recipient, so health counts and support lookups never need the address;
--   `payload_json` holds the composed message (the drainer needs the address to send) and is
--   stripped one hour after an `auth` row is sent. `status` queued | sending | sent | deferred |
--   failed | suppressed. `claim_token` is the drainer's two-step claim (REL-13). `deadline_at` is
--   set for `auth` rows only: a sign-in code past its TTL is never sent late. `provider_message_id`
--   is the SMTP response's id, for 56-26's DSN matching. Rows are purged 7 days after sent/failed.
-- - `mail_hour_windows` — one counter per mailbox per clock hour, upserted
--   (`INSERT … ON DUPLICATE KEY UPDATE`) like `rate_limit_buckets`.
--
-- ## Global (NON_TENANT_TABLES)
--
-- `organization_id` is nullable: platform mail (sign-in codes, password resets, operator alerts)
-- belongs to no organization. Reached only through `identityTransaction(['mail_queue'])` in the
-- API and the worker's own credential in the drainer.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, closed lists checked in code, no generated columns, no CHECK, no functional
-- indexes, utf8mb4_unicode_ci. Additive only.

CREATE TABLE mail_queue (
  id                  CHAR(36)      NOT NULL,
  organization_id     CHAR(36)      NULL,
  lane                VARCHAR(16)   NOT NULL,
  mailbox             VARCHAR(16)   NOT NULL,
  to_hash             CHAR(64)      NOT NULL,
  template_key        VARCHAR(64)   NOT NULL,
  payload_json        TEXT          NOT NULL,
  status              VARCHAR(16)   NOT NULL DEFAULT 'queued',
  attempts            TINYINT       NOT NULL DEFAULT 0,
  claim_token         CHAR(36)      NULL,
  available_at        DATETIME(3)   NOT NULL,
  deadline_at         DATETIME(3)   NULL,
  created_at          DATETIME(3)   NOT NULL,
  sent_at             DATETIME(3)   NULL,
  provider_message_id VARCHAR(255)  NULL,
  error               VARCHAR(255)  NULL,
  PRIMARY KEY (id),
  KEY ix_mail_queue_drain (status, lane, available_at),
  KEY ix_mail_queue_org (organization_id, id),
  KEY ix_mail_queue_claim (claim_token)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE mail_hour_windows (
  mailbox      VARCHAR(16)  NOT NULL,
  window_start DATETIME(3)  NOT NULL,
  count        INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (mailbox, window_start)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
