-- 0204_password_reset_tokens — self-service password reset (ID-002 recovery, walkthrough ACC-02).
--
-- Governing sources: 04-SECURITY-PRIVACY §3 (recovery), 22-SCREEN-BY-SCREEN §3 ID-05 ("we will
-- send a link to your work email. It works once and expires in 30 minutes"), 26-THREAT-MODELS
-- (no account enumeration).
--
-- ## A global identity table, like `sessions` and `user_passwords`
--
-- A reset belongs to a person, not to an organization: the person asking has no session and
-- names no tenant, so the row carries no `organization_id` and is registered in
-- `NON_TENANT_TABLES` (`tenant-guard.ts`) beside the other credential tables.
--
-- ## Only the hash is stored, and a link works once
--
-- `token_hash` is the SHA-256 hex of a 256-bit random token that is mailed and never stored —
-- the posture `invitations` (0005) and `session_refresh_tokens` (0003) take. `used_at` is set by
-- a compare-and-set (`WHERE used_at IS NULL AND expires_at > now`), so two requests racing with
-- one link change the password at most once. Requesting a new link marks every older unused
-- link for that person used, so only the newest one works.
--
-- MariaDB-safe: plain columns, no generated columns, no JSON, no expression defaults beyond
-- CURRENT_TIMESTAMP(3) (Hostinger runs MariaDB; see the 2026-10-17 deploy note on 0011).

CREATE TABLE password_reset_tokens (
  id          CHAR(36)    NOT NULL,
  user_id     CHAR(36)    NOT NULL,
  token_hash  CHAR(64)    NOT NULL,
  expires_at  DATETIME(3) NOT NULL,
  used_at     DATETIME(3) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_password_reset_tokens_hash (token_hash),
  KEY ix_password_reset_tokens_user (user_id, used_at),
  CONSTRAINT fk_password_reset_tokens_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
