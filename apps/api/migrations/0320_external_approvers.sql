-- 0320_external_approvers — the account-less approver of one deliverable version (52-18).
--
-- ## What this migration is for
--
-- An org member sends a deliverable version to an outside e-mail for approval. The 56-07 public
-- link system (0257) already holds the secret: the hashed token, expiry, the e-mail code, the
-- one terminal decision and the append-only event trail. This table is the APPROVAL side of that
-- link — who was asked, by whom, for which exact version, and what they answered:
--
-- - `public_link_id` names the one `public_links` row (kind `approval`, target
--   `deliverable_version`) the approver opens at `/a/<token>`. Unique per organization: one
--   approver record per link, so a decision can be recorded once.
-- - `content_hash` is the version's hash at send time; the link binds the same hash, so a newer
--   version makes the old link answer "superseded" and its decision can never land.
-- - `decision` (`approve | request_changes`), `decision_comment`, `typed_name`, `email_verified`,
--   `decided_at`, `decided_ip_hash` (HMAC under the public-link pepper, never the raw IP) and
--   `decided_user_agent` are written once, by the link's decision transaction.
--
-- TENANT: keyed `(organization_id, id)`; every read and write carries `organization_id` (members
-- through their own context, the outsider through the link's service context).
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, closed lists checked in `approvals/external-approvals.service.ts`, DATETIME(3),
-- no generated columns, no CHECK, no functional or partial indexes, utf8mb4_unicode_ci.
-- Additive only: one new table.

CREATE TABLE external_approvers (
  id                     CHAR(36)      NOT NULL,
  organization_id        CHAR(36)      NOT NULL,
  public_link_id         CHAR(36)      NOT NULL,
  project_id             CHAR(36)      NOT NULL,
  deliverable_id         CHAR(36)      NOT NULL,
  deliverable_version_id CHAR(36)      NOT NULL,
  content_hash           CHAR(64)      NOT NULL,
  email                  VARCHAR(320)  NOT NULL,
  display_name           VARCHAR(120)  NULL,
  message                VARCHAR(1000) NULL,
  language               VARCHAR(5)    NOT NULL DEFAULT 'en',
  requested_by_user_id   CHAR(36)      NOT NULL,
  requested_at           DATETIME(3)   NOT NULL,
  decision               VARCHAR(16)   NULL,
  decision_comment       VARCHAR(1000) NULL,
  typed_name             VARCHAR(120)  NULL,
  email_verified         TINYINT(1)    NOT NULL DEFAULT 0,
  decided_at             DATETIME(3)   NULL,
  decided_ip_hash        CHAR(64)      NULL,
  decided_user_agent     VARCHAR(255)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_external_approvers_org_id (organization_id, id),
  UNIQUE KEY uq_external_approvers_org_link (organization_id, public_link_id),
  KEY ix_external_approvers_version (organization_id, deliverable_version_id, requested_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
