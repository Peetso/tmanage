-- 0252_email_suppressions — the e-mail suppression list (51-11).
--
-- Governing source: 51-SWITCH-ON-PLAN §51-11 (List-Unsubscribe + one-click) and §9.2. No existing
-- table fits: `notification_preferences` (0022/0057) is per membership and per kind, keyed by a
-- user inside one organization, while a one-click unsubscribe arrives with no session and names an
-- address, which may belong to a client, a member of several organizations, or nobody yet.
--
-- ## GLOBAL, org-less, no raw address
--
-- One row per suppressed address, keyed by `address_hash`: the base64url SHA-256 of the trimmed,
-- lower-cased address (`emailAddressHash` in `packages/mail`). The raw address is never stored, so
-- the list is not a second copy of anyone's e-mail (KSA PDPL Art. 11, GDPR Art. 5(1)(c)); the
-- worker hashes each notification recipient and looks the hash up. Registered in the tenant
-- guard's NON_TENANT_TABLES and reached only through `identityTransaction`.
--
-- `reason` is a VARCHAR vocabulary: `one_click` (RFC 8058 POST) today; `bounce` / `complaint` are
-- 56's. `scope` is `notifications` today — transactional and security mail is never suppressed.
-- Insert-or-touch only (`INSERT … ON DUPLICATE KEY UPDATE`): the API holds INSERT and UPDATE, the
-- worker SELECT. No DELETE — re-subscribing is a later, signed-in flow.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns with literal defaults and CURRENT_TIMESTAMP(3), a primary key, VARCHAR
-- vocabulary, no CHECK, no generated column, no functional index, no trigger. Additive only.

CREATE TABLE email_suppressions (
  address_hash VARCHAR(64)  CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope        VARCHAR(32)  NOT NULL DEFAULT 'notifications',
  reason       VARCHAR(32)  NOT NULL DEFAULT 'one_click',
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (address_hash, scope)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
