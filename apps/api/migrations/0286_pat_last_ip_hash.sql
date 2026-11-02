-- 0286_pat_last_ip_hash — R15 (R14 slice b leftover, 56-09 API tokens): the last address a personal
-- access token was used from, stored only as a one-way hash.
--
-- `personal_access_tokens.last_ip_hash`: 40 hex chars of SHA-256 of the request address
-- (`hashAddress`, personal-access-token.ts — the same form the Bearer guard already writes to the
-- refusal audit for an IP-allowlist denial). Written with `last_used_at` on every successful use,
-- best-effort; NULL until the token is next used. The org-wide token overview shows it so an owner
-- can tell whether a token moved, without the raw address being kept.
--
-- No new table: the existing table-level grants (scripts/db/users.sql: SELECT, INSERT, UPDATE for
-- the app user) cover the new column; tenant-guard and users.sql are unchanged.
--
-- MariaDB 11.8 / MySQL 8 safe: plain ADD COLUMN, nullable, no default expression, no generated
-- column, no IF NOT EXISTS.

ALTER TABLE personal_access_tokens
  ADD COLUMN last_ip_hash CHAR(40) NULL AFTER last_used_at;
