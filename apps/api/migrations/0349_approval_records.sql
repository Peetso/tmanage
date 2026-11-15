-- 0349_approval_records — the legal-grade approval record (52-19), backend half.
--
-- `approval_records` (TENANT): one immutable evidence row per reviewer decision on an approval,
-- written inside the decision's own transaction. `record_json` is the canonical JSON (keys sorted
-- at every depth) of who decided (user id, internal or client, role, client organization), what
-- (deliverable, version, the version's SHA-256 content hash), the decision, the comment, when, and
-- the IP address and user agent the API saw. `record_hash` = SHA-256 of `record_json`.
--
-- The rows of one organization form a hash chain: `record_no` is 1, 2, 3 … per organization
-- (gapless, unique) and `previous_record_hash` is the hash of record `record_no - 1` (the first
-- record points at a per-organization genesis hash). `signature` is an HMAC over the record hash
-- under the server's audit anchor key (`v1:<keyId>:<hex>`), NULL when no key is configured.
-- Editing a stored record breaks its hash, its signature and the next record's link.
--
-- The API credential gets INSERT only (scripts/db/users.sql): a record is never rewritten or
-- removed at runtime; the company erasure empties it with every other tenant table.
--
-- MariaDB-safe (live is MariaDB 11.8): plain columns, DATETIME(3), no generated columns, no CHECK,
-- no functional or partial indexes, utf8mb4_unicode_ci. Additive only.

CREATE TABLE approval_records (
  id                        CHAR(36)       NOT NULL,
  organization_id           CHAR(36)       NOT NULL,
  approval_id               CHAR(36)       NOT NULL,
  deliverable_version_id    CHAR(36)       NOT NULL,
  record_no                 INT UNSIGNED   NOT NULL,
  approver_user_id          CHAR(36)       NOT NULL,
  approver_kind             VARCHAR(16)    NOT NULL,
  decision                  VARCHAR(32)    NOT NULL,
  record_json               MEDIUMTEXT     NOT NULL,
  record_hash               CHAR(64)       NOT NULL,
  previous_record_hash      CHAR(64)       NOT NULL,
  signature                 VARCHAR(160)   NULL,
  created_at                DATETIME(3)    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_approval_records_org_id (organization_id, id),
  UNIQUE KEY uq_approval_records_org_no (organization_id, record_no),
  KEY ix_approval_records_org_approval (organization_id, approval_id, record_no)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
