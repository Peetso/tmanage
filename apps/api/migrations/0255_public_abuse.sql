-- 0255_public_abuse — the public-endpoint abuse engine (52-21; spec 52 §52-21, §16.4).
--
-- ## What this migration is for
--
-- Every anonymous write door (sign-up, the contact form, and the public intake forms 52-20 adds)
-- asks one function, `assessPublicWrite`, whether a submission is a person or a script. The rate
-- windows ride 56-05's `rate_limit_buckets` under new bucket names (no second window table); this
-- migration adds only what the buckets cannot hold:
--
-- - `org_block_rules` (TENANT) — an organization's own "never accept from" list: one e-mail
--   address, one e-mail domain or one IP address per row. Managed by `org.security.manage`.
-- - `public_abuse_events` (GLOBAL) — one row per assessed public action: the decision, the score
--   and the reason codes. **No content**: `key_hash` is an HMAC of the submitted values (so a
--   repeat can be recognised for 24 h), the IP is truncated to /24 (IPv4) or /56 (IPv6) before
--   it is written. Purged after 30 days.
-- - `public_challenges` (GLOBAL) — an issued challenge (e-mail code, proof-of-work, Turnstile):
--   the target and the code are hashes, never the address or the code. Purged once expired.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, closed lists checked in the application, DATETIME(3), no generated columns, no
-- CHECK, no functional indexes, utf8mb4_unicode_ci. Additive only: three new tables and one new
-- column with a default on `marketing_leads`.

CREATE TABLE org_block_rules (
  id                 CHAR(36)      NOT NULL,
  organization_id    CHAR(36)      NOT NULL,
  kind               VARCHAR(8)    NOT NULL,
  value              VARCHAR(254)  NOT NULL,
  reason             VARCHAR(200)  NULL,
  created_by_user_id CHAR(36)      NULL,
  created_at         DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_org_block_rules_org_id (organization_id, id),
  UNIQUE KEY uq_org_block_rules_value (organization_id, kind, value)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE public_abuse_events (
  id              CHAR(36)      NOT NULL,
  kind            VARCHAR(32)   NOT NULL,
  surface         VARCHAR(64)   NOT NULL,
  key_hash        CHAR(64)      NOT NULL,
  ip_text         VARCHAR(45)   NULL,
  decision        VARCHAR(16)   NOT NULL,
  score           SMALLINT      NOT NULL,
  reasons         VARCHAR(255)  NULL,
  organization_id CHAR(36)      NULL,
  created_at      DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  KEY ix_public_abuse_events_created (created_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE public_challenges (
  id          CHAR(36)      NOT NULL,
  kind        VARCHAR(16)   NOT NULL,
  target_hash CHAR(64)      NOT NULL,
  code_hash   CHAR(64)      NULL,
  attempts    TINYINT       NOT NULL DEFAULT 0,
  expires_at  DATETIME(3)   NOT NULL,
  solved_at   DATETIME(3)   NULL,
  created_at  DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  KEY ix_public_challenges_expires (expires_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A held or spam contact lead is still stored (nothing a person typed is lost), but marked, so the
-- "Likely spam?" tray (52-20, F-34) can show it apart and nothing downstream delivers it.
-- `clear | held | spam`; existing rows are `clear`.
ALTER TABLE marketing_leads
  ADD COLUMN review_status VARCHAR(16) NOT NULL DEFAULT 'clear';
