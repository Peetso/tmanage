-- 0351_plan_versions — the final plan ladder as data (57-02, doc 57 §4.5 57-M1/57-M2).
--
-- `plan_versions` (GLOBAL, no organization_id): one immutable row per published version of a plan's
-- price, limits and features. A later price or limit change is a NEW row with a higher `version`
-- and its own `effective_from`, never an edit (doc 49 §7), so a workspace that subscribed under an
-- earlier version keeps it (grandfathering): `subscriptions.plan_version` names the version the
-- workspace is on and is not moved by a new version. Version 1 of every plan is the code catalog
-- (`plan-catalog.ts`) as it stands, seeded here. Prices are integer cents; Enterprise is quoted
-- per contract, so its prices are NULL. `provider_price_ids_json` stays NULL until a payment
-- provider exists (57-03); nothing here charges anyone.
--
-- The ladder is OFF during the public beta (`PLAN_LADDER` unset and `BILLING_MODE=beta_free`):
-- every workspace keeps the free beta plan and these rows are only read by the Platform admin.
--
-- The API credential gets INSERT only (scripts/db/users.sql): a version is never rewritten.
--
-- MariaDB-safe (live is MariaDB 11.8): plain columns, JSON (a LONGTEXT alias on MariaDB), DATETIME(3),
-- no generated columns, no CHECK, no functional or partial indexes, utf8mb4_unicode_ci. Additive only.

CREATE TABLE plan_versions (
  id                      CHAR(36)     NOT NULL,
  plan_id                 VARCHAR(64)  NOT NULL,
  version                 INT UNSIGNED NOT NULL,
  currency                CHAR(3)      NOT NULL DEFAULT 'USD',
  monthly_cents           INT UNSIGNED NULL,
  yearly_cents            INT UNSIGNED NULL,
  limits_json             JSON         NOT NULL,
  features_json           JSON         NOT NULL,
  provider_price_ids_json JSON         NULL,
  effective_from          DATETIME(3)  NOT NULL,
  created_by_user_id      CHAR(36)     NULL,
  created_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_plan_versions_plan_currency_version (plan_id, currency, version),
  CONSTRAINT fk_plan_versions_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO plan_versions
  (id, plan_id, version, currency, monthly_cents, yearly_cents, limits_json, features_json,
   effective_from)
VALUES
  ('01900000-0000-7000-8000-000000000351', 'free', 1, 'USD', 0, 0,
   '{"people":3,"activeProjects":3,"storageBytes":2147483648,"maxFileBytes":26214400}',
   '[]',
   '2026-01-01 00:00:00.000'),
  ('01900000-0000-7000-8000-000000000352', 'starter', 1, 'USD', 1900, 18240,
   '{"people":10,"activeProjects":null,"storageBytes":26843545600,"maxFileBytes":262144000}',
   '["requests_approvals","client_portal"]',
   '2026-01-01 00:00:00.000'),
  ('01900000-0000-7000-8000-000000000353', 'studio', 1, 'USD', 4900, 47040,
   '{"people":null,"activeProjects":null,"storageBytes":107374182400,"maxFileBytes":1073741824}',
   '["requests_approvals","client_portal","docs_decisions","insights_automations"]',
   '2026-01-01 00:00:00.000'),
  ('01900000-0000-7000-8000-000000000354', 'business', 1, 'USD', 8900, 85440,
   '{"people":null,"activeProjects":null,"storageBytes":536870912000,"maxFileBytes":2147483648}',
   '["requests_approvals","client_portal","docs_decisions","insights_automations","security_controls","admin_audit"]',
   '2026-01-01 00:00:00.000'),
  ('01900000-0000-7000-8000-000000000355', 'enterprise', 1, 'USD', NULL, NULL,
   '{"people":null,"activeProjects":null,"storageBytes":1099511627776,"maxFileBytes":5368709120}',
   '["requests_approvals","client_portal","docs_decisions","insights_automations","security_controls","admin_audit"]',
   '2026-01-01 00:00:00.000');

-- 57-M2. The version and currency a workspace's subscription is on. Every existing row is on the
-- seeded version 1 in USD, which is exactly what it was billed against before this migration.
ALTER TABLE subscriptions
  ADD COLUMN plan_version INT UNSIGNED NOT NULL DEFAULT 1,
  ADD COLUMN currency     CHAR(3)      NOT NULL DEFAULT 'USD';
