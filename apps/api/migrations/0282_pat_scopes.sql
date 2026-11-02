-- 0282_pat_scopes — R13 slice 3 (56-09 API tokens): scopes and an IP allowlist on personal access tokens.
--
-- 1. `personal_access_tokens.scopes`: the space-separated OAuth-style scopes the token holds, from the
--    same vocabulary the MCP OAuth path uses (`tmanage:read`, `tmanage:write`, `tmanage:manage`,
--    `tmanage:billing`, `oauth/scopes.ts`). Every existing row keeps exactly what it could do in
--    practice for everyday work — read plus write — and is never widened to manage or billing. The
--    Bearer guard classifies each route (read / write / manage / billing) and refuses a token that
--    lacks the class with 403; a scope only ever narrows, the capability gate still runs.
-- 2. `personal_access_tokens.ip_allowlist_json`: an optional JSON list of IP addresses / CIDR ranges
--    (validated by `admin/cidr.ts`, at most 50). NULL or an empty list means "any address".
--
-- No new table: the existing table-level grants (scripts/db/users.sql) cover the new columns, and
-- tenant-guard / users.sql are unchanged. The org-wide token overview reads the same table as the
-- same app user.
--
-- MariaDB 11.8 / MySQL 8 safe: plain ADD COLUMN, no generated column, no IF NOT EXISTS, no CHECK,
-- no expression default; TEXT (not JSON) for the allowlist so MariaDB stores it the same way.

ALTER TABLE personal_access_tokens
  ADD COLUMN scopes VARCHAR(190) NOT NULL DEFAULT 'tmanage:read tmanage:write' AFTER token_prefix,
  ADD COLUMN ip_allowlist_json TEXT NULL AFTER scopes;
