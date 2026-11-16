-- 0359_organization_signup_source — where a public sign-up came from (ADTRACK, 2026-11-16).
--
-- The Meta ad optimises for link clicks and nothing reported a completed sign-up, so the platform
-- operator could not see which ad produced accounts. The web proxy keeps the landing address's
-- `utm_source` / `utm_medium` / `utm_campaign` / `utm_content` in a first-party cookie, and the
-- sign-up endpoint (password or Google) stores the values on the organization it creates. The
-- platform overview (`GET /v1/platform/overview`) counts organizations by them.
--
-- The values are labels only: validated by the shared schema (`@tmanage/domain`
-- `parseSignupAttribution`: 1-100 characters of [A-Za-z0-9_.-]) before they reach this table, and
-- never used for a decision. NULL for every organization before this migration, for one created
-- by first-owner setup or the platform operator, and for a sign-up that arrived without them.
--
-- MariaDB-safe: plain nullable ADD COLUMN, no CHECK, no generated column, no index. The columns
-- ride the existing `organizations` INSERT grant (scripts/db/users.sql).

ALTER TABLE organizations
  ADD COLUMN signup_utm_source   VARCHAR(100) NULL,
  ADD COLUMN signup_utm_medium   VARCHAR(100) NULL,
  ADD COLUMN signup_utm_campaign VARCHAR(100) NULL,
  ADD COLUMN signup_utm_content  VARCHAR(100) NULL;
