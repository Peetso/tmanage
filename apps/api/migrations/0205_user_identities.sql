-- 0205_user_identities — "Continue with Google" (OpenID Connect sign-in).
--
-- ## A global identity table, like `user_passwords` and `password_reset_tokens`
--
-- An external sign-in identity belongs to a person, not to an organization: it is read on the
-- unauthenticated callback before any tenant is named, so the row carries no `organization_id`
-- and is registered in `NON_TENANT_TABLES` (`tenant-guard.ts`) beside the other credential
-- tables.
--
-- ## What is stored
--
-- `provider` + `subject` is the provider's stable account id (Google's `sub`), never the email:
-- an address can be renamed or recycled, the subject cannot. `email` is the verified address
-- the provider asserted when the link was made — evidence, not a lookup key. One identity per
-- provider per person (`uq_user_identities_user_provider`), and one person per provider
-- account (`uq_user_identities_subject`).
--
-- MariaDB-safe: plain columns, no generated columns, no JSON, no expression defaults beyond
-- CURRENT_TIMESTAMP(3) (Hostinger runs MariaDB; see the 2026-10-17 deploy note on 0011).

CREATE TABLE user_identities (
  id            CHAR(36)     NOT NULL,
  user_id       CHAR(36)     NOT NULL,
  provider      VARCHAR(32)  NOT NULL,
  subject       VARCHAR(255) NOT NULL,
  email         VARCHAR(254) NOT NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at  DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_identities_subject (provider, subject),
  UNIQUE KEY uq_user_identities_user_provider (user_id, provider),
  CONSTRAINT fk_user_identities_user FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
