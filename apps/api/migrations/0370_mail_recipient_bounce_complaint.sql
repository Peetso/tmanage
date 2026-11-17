-- 0370_mail_recipient_bounce_complaint — spam complaints beside bounces (56-26 ARF).
--
-- A feedback-loop complaint (RFC 5965 ARF, "this person marked the mail as spam") posted to the
-- signed bounce intake suppresses the recipient address in `mail_recipient_bounces` (0366), the
-- same store bounces use, with `last_kind = 'complaint'` and `last_status` the feedback type
-- (`abuse` or `fraud`). 'complaint' is nine characters: `last_kind` grows from VARCHAR(8) to
-- VARCHAR(16). The vocabulary ('hard', 'soft', 'complaint') stays checked in code.
--
-- MariaDB-safe (live is MariaDB 11.8): one MODIFY widening a plain VARCHAR, same NOT NULL, no
-- default, no CHECK, no generated column. Every existing value fits; running it twice changes
-- nothing.

ALTER TABLE mail_recipient_bounces
  MODIFY last_kind VARCHAR(16) NOT NULL;
