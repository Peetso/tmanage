-- 0354_signature_requests — simple electronic signature (52-26), portal half.
--
-- `signature_requests` (TENANT): the team asks named client contacts to sign one exact deliverable
-- version. `content_hash` pins the version's SHA-256 at request time; signing re-checks it, so a
-- changed document can never be signed under an older request. `status` is `pending`, `completed`
-- (every signer signed) or `cancelled`; a pending request past `expires_at` reads as expired.
--
-- `signature_request_signers` (TENANT): one row per named client contact (a client membership's
-- user). The one-time e-mail code lives here only as an HMAC (`code_hash`, the public-link pepper,
-- bound to the signer row), with its expiry, the wrong-attempt count and the send window that rate
-- limits new codes. A signature is sealed as an `approval_records` row (52-19 chain, decision
-- `signed`) and `record_id` points at it. A drawn mark is a PNG in the private object store under
-- the tenant prefix (`mark_object_key`), never under the web root; `mark_sha256` is also sealed.
--
-- The API credential gets INSERT and UPDATE on both (scripts/db/users.sql); no DELETE: a request is
-- cancelled, never removed. The company erasure empties both with every other tenant table.
--
-- MariaDB-safe (live is MariaDB 11.8): plain columns, DATETIME(3), no generated columns, no CHECK,
-- no functional or partial indexes, utf8mb4_unicode_ci. Additive only.

CREATE TABLE signature_requests (
  id                      CHAR(36)      NOT NULL,
  organization_id         CHAR(36)      NOT NULL,
  project_id              CHAR(36)      NOT NULL,
  deliverable_id          CHAR(36)      NOT NULL,
  deliverable_version_id  CHAR(36)      NOT NULL,
  content_hash            CHAR(64)      NOT NULL,
  title                   VARCHAR(200)  NOT NULL,
  status                  VARCHAR(16)   NOT NULL DEFAULT 'pending',
  expires_at              DATETIME(3)   NOT NULL,
  created_by              CHAR(36)      NOT NULL,
  created_at              DATETIME(3)   NOT NULL,
  completed_at            DATETIME(3)   NULL,
  cancelled_at            DATETIME(3)   NULL,
  reminded_at             DATETIME(3)   NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_signature_requests_org_id (organization_id, id),
  KEY ix_signature_requests_org_version (organization_id, deliverable_version_id, created_at),
  CONSTRAINT fk_signature_requests_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_signature_requests_version
    FOREIGN KEY (organization_id, deliverable_version_id)
    REFERENCES deliverable_versions (organization_id, id),
  CONSTRAINT fk_signature_requests_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE signature_request_signers (
  id                      CHAR(36)          NOT NULL,
  organization_id         CHAR(36)          NOT NULL,
  request_id              CHAR(36)          NOT NULL,
  user_id                 CHAR(36)          NOT NULL,
  client_organization_id  CHAR(36)          NOT NULL,
  status                  VARCHAR(16)       NOT NULL DEFAULT 'pending',
  code_hash               CHAR(64)          NULL,
  code_expires_at         DATETIME(3)       NULL,
  code_attempts           SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  code_sent_at            DATETIME(3)       NULL,
  code_window_started_at  DATETIME(3)       NULL,
  codes_in_window         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  code_verified_at        DATETIME(3)       NULL,
  viewed_at               DATETIME(3)       NULL,
  signed_at               DATETIME(3)       NULL,
  method                  VARCHAR(8)        NULL,
  typed_name              VARCHAR(120)      NULL,
  mark_object_key         VARCHAR(255)      NULL,
  mark_sha256             CHAR(64)          NULL,
  record_id               CHAR(36)          NULL,
  created_at              DATETIME(3)       NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_signature_request_signers_org_id (organization_id, id),
  UNIQUE KEY uq_signature_request_signers_request_user (organization_id, request_id, user_id),
  KEY ix_signature_request_signers_org_user (organization_id, user_id, status),
  CONSTRAINT fk_signature_request_signers_request
    FOREIGN KEY (organization_id, request_id) REFERENCES signature_requests (organization_id, id),
  CONSTRAINT fk_signature_request_signers_user
    FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
