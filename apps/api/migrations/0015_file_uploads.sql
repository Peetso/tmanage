-- 0015_file_uploads — the upload session, the reservation, and the first file rows (FILE-001).
--
-- Governing sources: 49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY.md §4 (key layout, trust
-- zones), §5 (accounting) and §6 (atomic quota enforcement, the seven steps);
-- 50-BOOTSTRAP-DEPLOYMENT-ON-ONE-PAID-PLAN.md §5 (500 MB per organization, 100 MB per
-- upload); 23-ERD-AND-STATE-MACHINES.md §10 (the upload lifecycle); contracts/openapi.yaml
-- (`createUploadSession`, `completeUploadSession`); contracts/tmanage-core.dbml
-- (`file_assets`, `file_versions`, `storage_reservations`, `usage_counters`); 24-EVENT-CATALOG
-- (`upload.completed.v1`, `usage.storage_*.v1`).
--
-- ## Four tables, and why the DBML's four are not quite these
--
-- `usage_counters` and `file_versions` are the DBML's. `file_assets` is the DBML's plus what
-- 23-ERD §3 requires of every mutable tenant table (`version`, `updated_at`), plus `project_id`
-- and `purpose`, without which neither §4's key layout nor the contract's `purpose` field can
-- be satisfied, plus the `(organization_id, id)` key its child needs. `upload_sessions` is a
-- table the DBML does not have: `07-DATA-MODEL` and `21-REQUIREMENTS-TRACEABILITY` both name
-- it, the DBML's `storage_reservations` carries no file name, MIME type, purpose or part
-- size, and an upload session is exactly a reservation with those attached. So the two are
-- one table here, and the divergence is recorded in docs/implementation-status.md rather than
-- resolved by carrying a reservation row and a session row that can disagree.
--
-- ## The counter is the quota, and one statement is the rule
--
-- §6 step 3: "In one transaction, reserve declared bytes if used + reserved + declared <=
-- effective quota." That is one conditional UPDATE on `usage_counters`, and the predicate is
-- the whole enforcement: InnoDB holds the row lock for the statement, re-evaluates the
-- predicate after the lock is granted, and answers zero rows when the reservation would
-- oversubscribe. Two concurrent reservations serialise on the row; there is no read-then-write
-- for them to race through. The counter columns are BIGINT UNSIGNED so that a release that
-- exceeds what was reserved fails the statement rather than writing a negative number —
-- 27-TEST-CATALOG CONC-06's "counters never go negative", as a column type.
--
-- ## Two status columns, two lifecycles
--
-- `file_assets.status` is 23-ERD §10's nine-state machine (`packages/domain`'s
-- `uploadStateMachine`), and this migration's code drives only `created → uploading →
-- uploaded` and the two exits; verification, scanning and `ready` are FILE-002's.
-- `upload_sessions.status` is the *reservation's* lifecycle — reserved, completed, cancelled,
-- expired, failed — which is what §6 steps 4 and 7 describe and is not the file's. Neither
-- column has a DEFAULT, for the reason `client_requests.state` has none.
--
-- ## `object_key` is internal, and no response carries it
--
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §7 lists "internal file keys" among the fields a
-- client response never carries, and `FORBIDDEN_CLIENT_FIELDS` names `storageKey`. The key is
-- stored here and on the version so the worker can find the object; the only thing a caller
-- ever receives is the per-part upload URL the provider issued.

CREATE TABLE usage_counters (
  id                CHAR(36)        NOT NULL,
  organization_id   CHAR(36)        NOT NULL,
  -- `storage.bytes` is the only member today. VARCHAR rather than ENUM so USAGE-001's
  -- further metrics (seats, active projects) are rows, not a schema change.
  metric_key        VARCHAR(64)     NOT NULL,
  used_value        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  reserved_value    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  version           BIGINT UNSIGNED NOT NULL DEFAULT 1,
  -- USAGE-001's reconciliation against provider inventory writes this. Nothing does yet.
  reconciled_at     DATETIME(3)     NULL,
  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_usage_counters_org_id (organization_id, id),
  UNIQUE KEY uq_usage_counters_org_metric (organization_id, metric_key),
  CONSTRAINT fk_usage_counters_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE file_assets (
  id                     CHAR(36)     NOT NULL,
  organization_id        CHAR(36)     NOT NULL,
  -- Every file belongs to a project: §4's key layout has no place for one that does not.
  project_id             CHAR(36)     NOT NULL,
  -- Non-null only when a client principal uploaded it. It is what stops Atlas reading a
  -- file Meridian attached to a request in the same studio.
  client_organization_id CHAR(36)     NULL,
  owner_user_id          CHAR(36)     NOT NULL,
  name                   VARCHAR(255) NOT NULL,
  purpose                ENUM('message_attachment','request_attachment','deliverable','document')
                                      NOT NULL,
  audience               ENUM('internal','client_visible','client_action_required')
                                      NOT NULL DEFAULT 'internal',
  -- 23-ERD §10's machine. No DEFAULT — see above.
  status                 VARCHAR(32)  NOT NULL,
  -- Written by FILE-002's verification and scan, never by this slice.
  rejection_code         VARCHAR(64)  NULL,
  version                BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_file_assets_org_id (organization_id, id),
  KEY ix_file_assets_org_project_status (organization_id, project_id, status, created_at),
  CONSTRAINT fk_file_assets_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  -- Composite and nullable: unchecked when NULL, and a client's file cannot name another
  -- tenant's client organization when it is not.
  CONSTRAINT fk_file_assets_client_org_tenant
    FOREIGN KEY (organization_id, client_organization_id)
    REFERENCES client_organizations (organization_id, id),
  CONSTRAINT fk_file_assets_owner
    FOREIGN KEY (owner_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A version is immutable by construction: no `updated_at`, no `version`, and `users.sql`
-- grants INSERT only. `detected_mime_type` and `content_hash` are NULL until FILE-002's
-- worker writes them, and that worker's UPDATE grant arrives with FILE-002, not here.
CREATE TABLE file_versions (
  id                 CHAR(36)        NOT NULL,
  organization_id    CHAR(36)        NOT NULL,
  file_asset_id      CHAR(36)        NOT NULL,
  version_no         INT UNSIGNED    NOT NULL,
  object_key         VARCHAR(512)    NOT NULL,
  -- The provider's count, never the caller's declaration (§6 step 6).
  size_bytes         BIGINT UNSIGNED NOT NULL,
  declared_mime_type VARCHAR(150)    NOT NULL,
  detected_mime_type VARCHAR(150)    NULL,
  content_hash       VARCHAR(128)    NULL,
  etag               VARCHAR(255)    NULL,
  created_at         DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_file_versions_org_id (organization_id, id),
  UNIQUE KEY uq_file_versions_org_asset_no (organization_id, file_asset_id, version_no),
  CONSTRAINT fk_file_versions_asset_tenant
    FOREIGN KEY (organization_id, file_asset_id) REFERENCES file_assets (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE upload_sessions (
  id                     CHAR(36)        NOT NULL,
  organization_id        CHAR(36)        NOT NULL,
  project_id             CHAR(36)        NOT NULL,
  client_organization_id CHAR(36)        NULL,
  actor_user_id          CHAR(36)        NOT NULL,
  -- The asset this session will produce a version of. Created in the same transaction as
  -- the session, at `created`, so a session never names an asset that does not exist.
  file_asset_id          CHAR(36)        NOT NULL,
  -- The caller's `Idempotency-Key`. Unique per tenant: a replay reads the row it made and
  -- reserves nothing twice (§6 step 4).
  idempotency_key        VARCHAR(128)    NOT NULL,
  purpose                ENUM('message_attachment','request_attachment','deliverable','document')
                                         NOT NULL,
  declared_name          VARCHAR(255)    NOT NULL,
  declared_mime_type     VARCHAR(150)    NOT NULL,
  declared_bytes         BIGINT UNSIGNED NOT NULL,
  declared_content_hash  VARCHAR(128)    NULL,
  -- What the provider reported at completion. NULL until then.
  committed_bytes        BIGINT UNSIGNED NULL,
  part_size_bytes        INT UNSIGNED    NOT NULL,
  part_count             INT UNSIGNED    NOT NULL,
  object_key             VARCHAR(512)    NOT NULL,
  provider_upload_id     VARCHAR(255)    NOT NULL,
  -- The per-part targets the provider issued, kept so a replay answers the same URLs
  -- rather than opening a second provider upload. Structured content, no relations.
  upload_targets_json    JSON            NOT NULL,
  -- The reservation's lifecycle: reserved, completed, cancelled, expired, failed. No DEFAULT.
  status                 VARCHAR(32)     NOT NULL,
  version                BIGINT UNSIGNED NOT NULL DEFAULT 1,
  expires_at             DATETIME(3)     NOT NULL,
  completed_at           DATETIME(3)     NULL,
  created_at             DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                         ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_upload_sessions_org_id (organization_id, id),
  UNIQUE KEY uq_upload_sessions_org_idempotency (organization_id, idempotency_key),
  -- The expiry sweep and the per-project list, both beginning with organization_id (07 §9).
  KEY ix_upload_sessions_org_status_expires (organization_id, status, expires_at),
  KEY ix_upload_sessions_org_project_status (organization_id, project_id, status, created_at),
  CONSTRAINT fk_upload_sessions_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_upload_sessions_asset_tenant
    FOREIGN KEY (organization_id, file_asset_id) REFERENCES file_assets (organization_id, id),
  CONSTRAINT fk_upload_sessions_client_org_tenant
    FOREIGN KEY (organization_id, client_organization_id)
    REFERENCES client_organizations (organization_id, id),
  CONSTRAINT fk_upload_sessions_actor
    FOREIGN KEY (actor_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Identity is immutable at the engine (ADR-0001 layer 5), for the reason every other
-- trigger in this schema exists: a direct SQL session bypasses the application layers.
-- Beyond the tenant key, each table's own identity: the counter's metric, the asset's
-- project, owner and purpose, and on a session the bytes that were reserved and the key
-- the object lives under — a session whose `declared_bytes` could be edited after the
-- reservation would be a reservation the release could no longer undo exactly.
DELIMITER $$

CREATE TRIGGER trg_usage_counters_immutable
BEFORE UPDATE ON usage_counters FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'usage_counters.organization_id is immutable';
  END IF;
  IF NEW.metric_key <> OLD.metric_key THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'usage_counters.metric_key is immutable';
  END IF;
END$$

CREATE TRIGGER trg_file_assets_immutable
BEFORE UPDATE ON file_assets FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_assets.organization_id is immutable';
  END IF;
  IF NEW.project_id <> OLD.project_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_assets.project_id is immutable';
  END IF;
  IF NEW.owner_user_id <> OLD.owner_user_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_assets.owner_user_id is immutable';
  END IF;
  IF NEW.purpose <> OLD.purpose THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_assets.purpose is immutable';
  END IF;
END$$

CREATE TRIGGER trg_file_versions_immutable
BEFORE UPDATE ON file_versions FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.organization_id is immutable';
  END IF;
  IF NEW.file_asset_id <> OLD.file_asset_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.file_asset_id is immutable';
  END IF;
  IF NEW.object_key <> OLD.object_key THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.object_key is immutable';
  END IF;
  IF NEW.size_bytes <> OLD.size_bytes THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.size_bytes is immutable';
  END IF;
END$$

CREATE TRIGGER trg_upload_sessions_immutable
BEFORE UPDATE ON upload_sessions FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'upload_sessions.organization_id is immutable';
  END IF;
  IF NEW.project_id <> OLD.project_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'upload_sessions.project_id is immutable';
  END IF;
  IF NEW.file_asset_id <> OLD.file_asset_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'upload_sessions.file_asset_id is immutable';
  END IF;
  IF NEW.idempotency_key <> OLD.idempotency_key THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'upload_sessions.idempotency_key is immutable';
  END IF;
  IF NEW.declared_bytes <> OLD.declared_bytes THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'upload_sessions.declared_bytes is immutable';
  END IF;
  IF NEW.object_key <> OLD.object_key THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'upload_sessions.object_key is immutable';
  END IF;
END$$

DELIMITER ;
