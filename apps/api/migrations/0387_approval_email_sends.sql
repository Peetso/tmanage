-- 0387_approval_email_sends — what happened to each approval-request e-mail (QA-FIX-O H1).
--
-- ## What this migration is for
--
-- "Send for approval" with "Email the approver now" wrote an outbox event and nothing else, and
-- the worker sends the e-mail after its batch commits, absorbing a failure into a log line. So
-- nobody could see whether the approver was e-mailed: on live the e-mails were never sent at all
-- (the in-process relay had no collaboration mailer) and the deliverable page still said
-- "Waiting for the client". This table is the per-send delivery state the page reads, and the
-- natural key a "Resend email" is refused on while a send is still in flight.
--
-- - `approval_email_sends` (TENANT): one row per approver per send. The API inserts it as
--   `queued` in the transaction that writes the `approval.requested.v1` outbox event (AS-1); the
--   event's payload names the row ids (`emailSendIds`). The worker moves each row once:
--   `queued` → `sent` (a mail server accepted it), `failed` (it refused, or the send threw) or
--   `not_sent` with a `cause` (`mail_off`, `no_access`, `no_transport`). The worker's UPDATE is
--   conditional on `state = 'queued'`, so a redelivered event never rewrites an outcome (AS-2).
--   Ids, a state and a cause only: never the address, never the message.
--
-- Grants (scripts/db/users.sql 0387 block): app INSERT (SELECT rides the database-wide read);
-- worker SELECT, UPDATE; erasure SELECT, DELETE (company erasure).
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATETIME(3), VARCHAR states checked in code, no CHECK, no generated column, no
-- JSON column, no functional or partial index, no trigger, no foreign key (the 0257 convention).
-- One CREATE; the migrator treats "already exists" on a re-run as applied (DA-8).

CREATE TABLE approval_email_sends (
  id                   CHAR(36)    NOT NULL,
  organization_id      CHAR(36)    NOT NULL,
  approval_id          CHAR(36)    NOT NULL,
  send_id              CHAR(36)    NOT NULL,
  recipient_user_id    CHAR(36)    NOT NULL,
  requested_by_user_id CHAR(36)    NOT NULL,
  state                VARCHAR(16) NOT NULL DEFAULT 'queued',
  cause                VARCHAR(32) NULL,
  created_at           DATETIME(3) NOT NULL,
  settled_at           DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_approval_email_sends_org_id (organization_id, id),
  UNIQUE KEY uq_approval_email_sends_send_recipient (organization_id, send_id, recipient_user_id),
  KEY ix_approval_email_sends_approval (organization_id, approval_id, created_at, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
