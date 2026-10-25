-- 0231_privacy_requests — data export and deletion requests (lane D5, Figma F5, audit gap 16 / NFR-09,
-- 33-LEGAL §8 data rights).
--
-- `privacy_exports`: one request for a downloadable archive. `kind = company` is the owner's export of
-- everything in the studio; `kind = member` is one person's personal data — asked for by an owner about
-- a member, or by a member about themselves (`subject_user_id` is that person). The in-process privacy
-- job claims a `preparing` row (`claimed_at`, conditional on `version`), builds the archive, writes it to
-- the object store's private zone through the malware scanner (the scan policy), and moves the row to
-- `ready` with `expires_at` (the download link's end, 7 days) or to `failed`. Expiry is derived from
-- `expires_at`; `purged_at` records that the job removed the archive's bytes after it.
--
-- `privacy_deletion_requests`: a request to delete the company (`kind = company`, owner-only) or one
-- person's account in this studio (`kind = account`). It is `scheduled` with `scheduled_for` (the end of
-- the 30-day grace period), can be `cancelled` until then, and is `executed` by the privacy job once the
-- date has passed. "One active request per subject" is enforced in the transaction that creates it
-- (a locking read), not by a partial unique key, which MariaDB does not have.
--
-- Org-scoped like every tenant table: `(organization_id, id)` unique key, organization FK. Written by
-- the API credential (INSERT, UPDATE); no DELETE — the trail of who asked for what is the record.
-- MariaDB-safe: plain columns, no CHECK, no generated column, no JSON default.

CREATE TABLE privacy_exports (
  id                   CHAR(36)        NOT NULL,
  organization_id      CHAR(36)        NOT NULL,
  kind                 ENUM('company', 'member') NOT NULL,
  -- The person a `member` export is about; NULL for a company export.
  subject_user_id      CHAR(36)        NULL,
  requested_by_user_id CHAR(36)        NOT NULL,
  status               ENUM('preparing', 'ready', 'failed') NOT NULL DEFAULT 'preparing',
  progress_percent     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  object_key           VARCHAR(255)    NULL,
  size_bytes           BIGINT UNSIGNED NULL,
  -- `clean` when the scanner cleared the archive; `not_scanned` when no scanner is configured.
  scan_status          ENUM('clean', 'not_scanned') NULL,
  failure_code         VARCHAR(64)     NULL,
  claimed_at           DATETIME(3)     NULL,
  requested_at         DATETIME(3)     NOT NULL,
  completed_at         DATETIME(3)     NULL,
  expires_at           DATETIME(3)     NULL,
  purged_at            DATETIME(3)     NULL,
  version              BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at           DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_privacy_exports_org_id (organization_id, id),
  KEY ix_privacy_exports_org_requested (organization_id, requested_at, id),
  KEY ix_privacy_exports_org_subject (organization_id, subject_user_id, requested_at),
  KEY ix_privacy_exports_status (status, claimed_at),
  CONSTRAINT fk_privacy_exports_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_privacy_exports_requested_by
    FOREIGN KEY (requested_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_privacy_exports_subject
    FOREIGN KEY (subject_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE privacy_deletion_requests (
  id                   CHAR(36)        NOT NULL,
  organization_id      CHAR(36)        NOT NULL,
  kind                 ENUM('company', 'account') NOT NULL,
  -- The person an `account` deletion removes; NULL for a company deletion.
  subject_user_id      CHAR(36)        NULL,
  requested_by_user_id CHAR(36)        NOT NULL,
  status               ENUM('scheduled', 'cancelled', 'executed') NOT NULL DEFAULT 'scheduled',
  requested_at         DATETIME(3)     NOT NULL,
  scheduled_for        DATETIME(3)     NOT NULL,
  cancelled_at         DATETIME(3)     NULL,
  cancelled_by_user_id CHAR(36)        NULL,
  executed_at          DATETIME(3)     NULL,
  version              BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at           DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_privacy_deletion_requests_org_id (organization_id, id),
  KEY ix_privacy_deletion_requests_org_kind (organization_id, kind, status),
  KEY ix_privacy_deletion_requests_due (status, scheduled_for),
  CONSTRAINT fk_privacy_deletion_requests_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_privacy_deletion_requests_requested_by
    FOREIGN KEY (requested_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_privacy_deletion_requests_subject
    FOREIGN KEY (subject_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
