-- 0262_security_reports — vulnerability disclosure intake (56-17; spec 56 §56-17).
--
-- ## What this migration is for
--
-- `/.well-known/security.txt` (RFC 9116, served by apps/server) points researchers at the
-- disclosure page, whose form posts to `POST /v1/public/security-reports`. Each accepted report is
-- one row here; the platform team triages it under `/v1/platform/security-reports`.
--
-- - `security_reports` (GLOBAL, NON_TENANT_TABLES) — a report about the platform, never about
--   one organization's data: no `organization_id`. `reference` is the only thing the reporter is
--   told (`SR-` + 8 symbols). `reporter_email_enc` is a 56-02 FieldCipher envelope (purpose
--   `reporter_email`, owner = the row id); a keyless host stores NULL rather than plaintext.
--   `title` / `body` are plain text (HTML refused at the door, body ≤ 20 000 characters).
--   `status` new | triaged | fixed | duplicate | invalid and `severity_claimed` none | low |
--   medium | high | critical are closed lists checked in `security-report-content.ts`.
--   `risk_decision` is 52-21's verdict (allow | hold | spam) so triage can sort the noise.
--   Retention: 24 months after `created_at` (docs/security/data-inventory.md), purge not yet built.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, closed lists checked in the application, DATETIME(3), no generated columns, no
-- CHECK, no JSON defaults, no functional indexes, utf8mb4_unicode_ci. Additive only: one table.

CREATE TABLE security_reports (
  id                 CHAR(36)      NOT NULL,
  reference          VARCHAR(16)   NOT NULL,
  reporter_email_enc VARCHAR(600)  NULL,
  reporter_name      VARCHAR(200)  NULL,
  title              VARCHAR(200)  NOT NULL,
  body               TEXT          NOT NULL,
  severity_claimed   VARCHAR(16)   NOT NULL DEFAULT 'none',
  status             VARCHAR(16)   NOT NULL DEFAULT 'new',
  risk_decision      VARCHAR(16)   NOT NULL DEFAULT 'allow',
  language           VARCHAR(5)    NULL,
  created_at         DATETIME(3)   NOT NULL,
  updated_at         DATETIME(3)   NOT NULL,
  acknowledged_at    DATETIME(3)   NULL,
  resolved_at        DATETIME(3)   NULL,
  credit_name        VARCHAR(200)  NULL,
  credit_public      TINYINT(1)    NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_security_reports_reference (reference),
  KEY ix_security_reports_status (status, created_at),
  KEY ix_security_reports_created (created_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
