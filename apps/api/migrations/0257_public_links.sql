-- 0257_public_links — the one secure link system for outsiders (56-07; spec 56 §56-07).
--
-- ## What this migration is for
--
-- Approver links (52-18), public intake (52-20), quote accept (52-08), read-only share links and
-- the client magic sign-in (55-14) are all "a link a person without an account opens". This is
-- that pattern, built once:
--
-- - `public_links` (TENANT) — one link: its kind, the one object it reaches (`target_type`,
--   `target_id`, and for a decision the `version_hash` it binds), expiry, use cap, the optional
--   audience e-mail and e-mail-code requirement, revocation and the one terminal decision.
--   Only `token_hash` (HMAC-SHA-256 of the token with the server pepper) is stored; the token
--   itself is shown once to the creator. `token_hint` is its last 6 characters, for the list.
-- - `public_link_events` (TENANT) — append-only evidence: opened, code_sent, code_ok, decided,
--   submitted, refused. The IP is stored only as a peppered hash. INSERT (and the company
--   erasure's DELETE) only: no UPDATE grant, an event is never amended.
-- - `public_link_codes` (TENANT) — the live e-mail code of a link (hash only), its expiry and
--   attempts. Replaced on resend, deleted on success. Keyed `(organization_id, link_id)`: it has
--   no `id`, so its primary key leads with the tenant column (56-04 schema convention).
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, closed lists checked in the application, DATETIME(3), no generated columns, no
-- CHECK, no functional indexes, utf8mb4_unicode_ci. Additive only: three new tables.

CREATE TABLE public_links (
  id                 CHAR(36)      NOT NULL,
  organization_id    CHAR(36)      NOT NULL,
  kind               VARCHAR(16)   NOT NULL,
  token_hash         CHAR(64)      NOT NULL,
  token_hint         VARCHAR(8)    NOT NULL,
  target_type        VARCHAR(32)   NOT NULL,
  target_id          CHAR(36)      NOT NULL,
  version_hash       CHAR(64)      NULL,
  audience_email     VARCHAR(320)  NULL,
  require_code       TINYINT(1)    NOT NULL DEFAULT 0,
  language           VARCHAR(5)    NOT NULL DEFAULT 'en',
  expires_at         DATETIME(3)   NOT NULL,
  max_uses           INT           NULL,
  uses               INT           NOT NULL DEFAULT 0,
  decision           VARCHAR(16)   NULL,
  decided_at         DATETIME(3)   NULL,
  created_by_user_id CHAR(36)      NULL,
  created_at         DATETIME(3)   NOT NULL,
  revoked_at         DATETIME(3)   NULL,
  revoked_by_user_id CHAR(36)      NULL,
  last_opened_at     DATETIME(3)   NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_public_links_org_id (organization_id, id),
  UNIQUE KEY uq_public_links_token_hash (token_hash),
  KEY ix_public_links_target (organization_id, target_type, target_id),
  KEY ix_public_links_expires (expires_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE public_link_events (
  id              CHAR(36)      NOT NULL,
  organization_id CHAR(36)      NOT NULL,
  link_id         CHAR(36)      NOT NULL,
  kind            VARCHAR(16)   NOT NULL,
  detail          VARCHAR(1000) NULL,
  ip_hash         CHAR(64)      NULL,
  user_agent      VARCHAR(255)  NULL,
  created_at      DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_public_link_events_org_id (organization_id, id),
  KEY ix_public_link_events_link (organization_id, link_id, created_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE public_link_codes (
  link_id         CHAR(36)      NOT NULL,
  organization_id CHAR(36)      NOT NULL,
  code_hash       CHAR(64)      NOT NULL,
  expires_at      DATETIME(3)   NOT NULL,
  attempts        TINYINT       NOT NULL DEFAULT 0,
  created_at      DATETIME(3)   NOT NULL,
  PRIMARY KEY (organization_id, link_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
