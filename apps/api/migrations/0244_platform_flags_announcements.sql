-- 0244_platform_flags_announcements — platform feature flags, the platform banner, and a fuller
-- maintenance window.
--
-- ## What this migration is for
--
-- Platform admin v2 (SPEC §4 D2–D4, §6 0244, slice PA-10).
--
-- `platform_feature_flags` holds one row per optional module key (the code allowlist
-- `OPTIONAL_MODULE_FLAGS`): its platform default, and who gets it — everyone, an allowlist of
-- organizations (`allowlist_org_ids_json`), or a deterministic percentage of organizations.
-- `platform_org_flag_overrides` forces one flag on or off for one organization from the platform
-- side; Remove sets `removed_at` (no DELETE grant), and forcing it again clears it. The
-- organization-side flag read becomes: platform override → the organization's own row
-- (`org_feature_flags`) → platform default (rollout applied) → the code default. A flag without a
-- row here behaves exactly as before.
--
-- `platform_announcements` is the banner the operator shows across TManage, in English and
-- Arabic, to everyone, chosen organizations, or client portals, inside an optional window.
-- Nothing is hard-deleted: Delete unpublishes and sets `archived`.
--
-- `maintenance_windows` (0080) gains the Arabic message, the "block sign-in for non-admins while
-- down" switch, `updated_at` for edits, and `ended_at` for "End now".
--
-- ## Global tables (NON_TENANT_TABLES)
--
-- None of these belongs to one organization: they describe the platform. The organization ids in
-- `platform_org_flag_overrides` and in the JSON allowlists are references, not a tenant scope.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, VARCHAR vocabularies, TEXT for JSON-ish lists, literal defaults or
-- CURRENT_TIMESTAMP(3), no generated columns, no CHECK, no IF NOT EXISTS in ALTER.

CREATE TABLE platform_feature_flags (
  flag_key               VARCHAR(64)  NOT NULL,
  enabled                TINYINT(1)   NOT NULL DEFAULT 0,
  rollout                VARCHAR(16)  NOT NULL DEFAULT 'everyone',
  percentage             TINYINT      NULL,
  allowlist_org_ids_json TEXT         NULL,
  updated_by             CHAR(36)     NULL,
  updated_at             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (flag_key)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE platform_org_flag_overrides (
  id              CHAR(36)     NOT NULL,
  flag_key        VARCHAR(64)  NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  enabled         TINYINT(1)   NOT NULL,
  removed_at      DATETIME(3)  NULL,
  updated_by      CHAR(36)     NULL,
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pofo (flag_key, organization_id),
  KEY ix_pofo_org (organization_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE platform_announcements (
  id                   CHAR(36)      NOT NULL,
  title_en             VARCHAR(190)  NOT NULL,
  title_ar             VARCHAR(190)  NULL,
  body_en              TEXT          NOT NULL,
  body_ar              TEXT          NULL,
  severity             VARCHAR(16)   NOT NULL DEFAULT 'info',
  link_url             VARCHAR(2048) NULL,
  audience             VARCHAR(16)   NOT NULL DEFAULT 'everyone',
  audience_org_ids_json TEXT         NULL,
  dismissible          TINYINT(1)    NOT NULL DEFAULT 1,
  starts_at            DATETIME(3)   NULL,
  ends_at              DATETIME(3)   NULL,
  published            TINYINT(1)    NOT NULL DEFAULT 0,
  archived             TINYINT(1)    NOT NULL DEFAULT 0,
  created_by           CHAR(36)      NULL,
  created_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_pa_live (published, starts_at, ends_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE maintenance_windows
  ADD COLUMN message_ar TEXT NULL,
  ADD COLUMN block_sign_in TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN updated_at DATETIME(3) NULL,
  ADD COLUMN ended_at DATETIME(3) NULL;
