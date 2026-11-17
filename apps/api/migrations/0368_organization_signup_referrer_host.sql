-- 0368_organization_signup_referrer_host — the site a public sign-up was referred from (SEOD B11,
-- 2026-11-17).
--
-- 0359 stores a sign-up's `utm_*` values, but a visitor from a search engine or an AI assistant
-- (chatgpt.com, perplexity.ai, gemini.google.com, claude.ai) usually arrives without them. The web
-- proxy now keeps the referring site's HOST in the same first-party cookie, and the sign-up
-- endpoint stores it here; the platform overview counts sign-ups by it beside the `utm_*` values.
--
-- Host only, never the address, path or query: validated by the shared schema (`@tmanage/domain`
-- `signupReferrerHost`: lower-case DNS name, at most 253 characters, no IP address, not our own
-- site) before it reaches this table, and never used for a decision. NULL for every organization
-- before this migration and for a sign-up that arrived without a referring site.
--
-- MariaDB-safe: plain nullable ADD COLUMN, no CHECK, no generated column, no index. The column
-- rides the existing `organizations` INSERT grant (scripts/db/users.sql).

ALTER TABLE organizations
  ADD COLUMN signup_referrer_host VARCHAR(253) NULL;
