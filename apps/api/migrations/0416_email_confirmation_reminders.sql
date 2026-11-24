-- 0416_email_confirmation_reminders — the "Confirm your e-mail" reminders (RESENDVERIFY,
-- 2026-11-24).
--
-- The hourly person-mail sweep only mails members whose address is confirmed, so a person who
-- signed up with a password and never clicked the confirmation link heard nothing again. The API's
-- in-process reminder job now sends them the ordinary confirmation link (the
-- `EmailConfirmationService` token and mail) about 1, 3 and 7 days after sign-up, then stops.
--
-- One row per (person, reminder day) that was sent or tried. The job claims the row with
-- `INSERT IGNORE` on the primary key BEFORE it sends, so two processes (or a restart in the middle
-- of a run) never send the same reminder twice; `result` is filled in after the send (`sent`,
-- `not_sent`, `already_confirmed`; NULL while it is being sent). A tried reminder is not tried
-- again: the next reminder, two or four days later, is the retry.
--
-- GLOBAL like `password_reset_tokens`: a person's sign-up confirmation belongs to no company.
-- Erasure: `AccountErasure` deletes the rows by `user_id`.
--
-- MariaDB-safe (DA-5): one CREATE TABLE, no default, no CHECK, no generated column, no trigger,
-- no foreign key (the 0257 convention). `claimed_at` is a bound value from the API (DA-10).
-- Additive only (DA-6).

CREATE TABLE email_confirmation_reminders (
  user_id       CHAR(36)         NOT NULL,
  reminder_day  TINYINT UNSIGNED NOT NULL,
  claimed_at    DATETIME(3)      NOT NULL,
  result        VARCHAR(20)      NULL,
  PRIMARY KEY (user_id, reminder_day)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
