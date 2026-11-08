-- 0334_platform_governance — owner notices and two-person approvals for Platform admin (56-21, R46 L2).
--
-- ## What this migration is for
--
-- Two global tables (NON_TENANT_TABLES: they describe the platform operators, not a tenant):
--
-- - `platform_owner_notices` — one row per notice a platform admin sent to a company owner.
--   The owner is stored by user id; the address is read at send time and never stored here.
--   `delivery` is what the mailer answered (`queued`, `sent`, `none`, `failed`).
-- - `platform_action_approvals` — the two-person rule for risky platform actions (suspend company,
--   delete company, transfer ownership). One admin asks (`pending`), a DIFFERENT admin approves or
--   rejects, and the asker then runs the action once (`used`). A request expires after 24 hours.
--
-- The switch that turns the rule on is a `platform_settings` row (`two_person_approval`), so no
-- table change is needed for it.
--
-- `scripts/db/users.sql` gives `tmanage_app` INSERT on the notices (append-only evidence) and
-- INSERT, UPDATE on the approvals (decide, use). No DELETE on either. The worker holds nothing.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns and ordinary indexes: no generated columns, no CHECK, no foreign keys (the 0257
-- convention). Additive only.

CREATE TABLE platform_owner_notices (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  owner_user_id   CHAR(36)     NULL,
  subject         VARCHAR(190) NOT NULL,
  body            TEXT         NOT NULL,
  severity        VARCHAR(16)  NOT NULL DEFAULT 'info',
  delivery        VARCHAR(16)  NOT NULL DEFAULT 'queued',
  sent_by         CHAR(36)     NOT NULL,
  created_at      DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  KEY ix_pon_org (organization_id, created_at),
  KEY ix_pon_created (created_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE platform_action_approvals (
  id            CHAR(36)     NOT NULL,
  action        VARCHAR(64)  NOT NULL,
  target_id     CHAR(36)     NOT NULL,
  target_label  VARCHAR(190) NULL,
  reason        VARCHAR(500) NOT NULL,
  status        VARCHAR(16)  NOT NULL DEFAULT 'pending',
  requested_by  CHAR(36)     NOT NULL,
  requested_at  DATETIME(3)  NOT NULL,
  expires_at    DATETIME(3)  NOT NULL,
  decided_by    CHAR(36)     NULL,
  decided_at    DATETIME(3)  NULL,
  decision_note VARCHAR(500) NULL,
  used_at       DATETIME(3)  NULL,
  PRIMARY KEY (id),
  KEY ix_paa_status (status, requested_at),
  KEY ix_paa_target (action, target_id, status)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
