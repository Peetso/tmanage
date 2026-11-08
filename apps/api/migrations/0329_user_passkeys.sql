-- 0329_user_passkeys — passkeys (WebAuthn credentials) a person signs in with (56-22).
--
-- ## What this migration is for
--
-- One row per registered passkey: a platform authenticator (Touch ID, Windows Hello, a phone's
-- screen lock) or a roaming one (a security key). The row holds only PUBLIC material: the
-- credential id the browser presents, and the credential's public key (SubjectPublicKeyInfo,
-- base64url) with its COSE algorithm (-7 ES256, -257 RS256). There is no secret in this table.
--
-- - `credential_id_hash` is the SHA-256 (hex) of the raw credential id: the unique lookup key on
--   the public sign-in path (a credential id can be up to 1023 bytes, too long to index directly).
-- - `sign_count` is the authenticator's counter; an assertion whose counter does not move forward
--   (when either side is non-zero) is refused as a possible clone.
-- - `last_challenge_at` is the issue time (epoch ms) of the last challenge this credential
--   answered; a challenge issued at or before it is refused, which makes every sign-in challenge
--   single-use per credential without a challenge table.
-- - Removal is soft (`removed_at`), so the removal stays answerable; the person's own deletion
--   cascades from `users`.
--
-- GLOBAL (NON_TENANT_TABLES): a person's credentials are not forked per organization, and the
-- sign-in path reads this table before any tenant exists — the same reason as `user_mfa_factors`.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATETIME(3), no generated columns, no CHECK, no functional or partial indexes,
-- utf8mb4_unicode_ci. Additive only: one new table.

CREATE TABLE user_passkeys (
  id                   CHAR(36)          NOT NULL,
  user_id              CHAR(36)          NOT NULL,
  credential_id        TEXT              NOT NULL,
  credential_id_hash   CHAR(64)          NOT NULL,
  public_key           TEXT              NOT NULL,
  alg                  SMALLINT          NOT NULL,
  sign_count           BIGINT UNSIGNED   NOT NULL DEFAULT 0,
  last_challenge_at    BIGINT UNSIGNED   NOT NULL DEFAULT 0,
  name                 VARCHAR(100)      NOT NULL,
  transports           VARCHAR(200)      NULL,
  backed_up            TINYINT(1)        NOT NULL DEFAULT 0,
  created_at           DATETIME(3)       NOT NULL,
  last_used_at         DATETIME(3)       NULL,
  removed_at           DATETIME(3)       NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_passkeys_credential (credential_id_hash),
  KEY ix_user_passkeys_user (user_id, removed_at),
  CONSTRAINT fk_user_passkeys_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
