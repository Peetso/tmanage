-- 0374_person_mail_retry — a person mail that fails after its claim is retried, then given up
-- (MAILREST, EMAILBUILD2 open item).
--
-- ## What this migration is for
--
-- 0371's `mail_tip_log` row is the claim: written before the send, so a tip is never sent twice.
-- Until now a send that failed after the claim was simply lost. Four columns make the row the
-- send's record as well:
--
-- - `status`: 'sending' (claimed, attempt under way), 'sent', 'retry' (failed, due again at
--   `next_attempt_at`) or 'gave_up' (final: attempts used up, or a failure retrying cannot fix).
--   Existing rows are claims made before this migration: 'sent'.
-- - `attempts`: attempts started, the claim being the first. A retry takes the row back with
--   `UPDATE … WHERE status = 'retry' AND attempts = ?`, so two runs can never both send it.
-- - `next_attempt_at`: when a 'retry' row is due (back-off 1 h, 4 h, 12 h; four attempts in all).
-- - `last_error`: a short address-free token (`smtp_550`, `suppressed`, `no_longer_due` …).
--
-- A row left at 'sending' (the process died mid-send) is never retried: it may have gone out.
--
-- `ix_mail_tip_log_retry (status, next_attempt_at)` is the sweep's due-retry read (at most 25 rows
-- a run). TENANT table as before; the worker's grant grows from SELECT, INSERT to
-- SELECT, INSERT, UPDATE (users.sql).
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns with literal defaults, DATETIME(3), vocabulary checked in code, no CHECK, no
-- generated column, no functional or partial index, no trigger. Additive only; 0371 and 0373 are
-- not edited.

ALTER TABLE mail_tip_log
  ADD COLUMN status VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'sent',
  ADD COLUMN attempts TINYINT UNSIGNED NOT NULL DEFAULT 1,
  ADD COLUMN next_attempt_at DATETIME(3) NULL,
  ADD COLUMN last_error VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD KEY ix_mail_tip_log_retry (status, next_attempt_at);
