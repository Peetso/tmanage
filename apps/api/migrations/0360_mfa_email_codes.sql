-- 0360_mfa_email_codes — two-step verification by e-mail code, and a default method (MFAOPTIONS).
--
-- ## What this migration is for
--
-- 1. `user_mfa_factors.is_default`: the method a person's sign-in asks for first. At most one
--    live row per person carries 1 (the API sets it with one UPDATE over the person's rows);
--    none is a valid state and means "the newest factor first", as before this column.
-- 2. `user_mfa_email_codes`: one row per 6-digit code mailed to a person, either to finish a
--    sign-in (`purpose = 'sign_in'`) or to prove the mailbox while turning the method on
--    (`purpose = 'enrol'`). The code itself is never stored: `code_hash` is an HMAC-SHA256 of
--    the code under the API's session secret, salted with `binding_hash`, so a database dump
--    cannot be turned back into a code by trying all million of them.
--    - `binding_hash` is the SHA-256 of what the code is bound to — the signed sign-in
--      challenge, or the session and factor being enrolled — so a code is useless anywhere else.
--    - `attempts` counts wrong guesses; the fifth spends the row (`used_at`), and the binding is
--      then dead: no new code is sent for it and no method finishes it.
--    - `expires_at` is ten minutes after the send; `used_at` marks spent, replaced or dead.
--    Rows are never deleted by the API (a person's own deletion cascades from `users`).
--
-- GLOBAL (NON_TENANT_TABLES): the sign-in path reads it before any tenant exists — the same
-- reason as `user_mfa_factors`.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATETIME(3), TINYINT(1), no generated columns, no CHECK, no functional or
-- partial indexes, utf8mb4_unicode_ci. Additive only: one column with a default, one new table.

ALTER TABLE user_mfa_factors
  ADD COLUMN is_default TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE user_mfa_email_codes (
  id             CHAR(36)      NOT NULL,
  user_id        CHAR(36)      NOT NULL,
  factor_id      CHAR(36)      NOT NULL,
  purpose        VARCHAR(16)   NOT NULL,
  binding_hash   CHAR(64)      NOT NULL,
  code_hash      CHAR(64)      NOT NULL,
  attempts       SMALLINT      NOT NULL DEFAULT 0,
  created_at     DATETIME(3)   NOT NULL,
  expires_at     DATETIME(3)   NOT NULL,
  used_at        DATETIME(3)   NULL,
  PRIMARY KEY (id),
  KEY ix_user_mfa_email_codes_binding (binding_hash, used_at),
  KEY ix_user_mfa_email_codes_user (user_id, created_at),
  CONSTRAINT fk_user_mfa_email_codes_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
