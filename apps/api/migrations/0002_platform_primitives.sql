-- 0002_platform_primitives — outbox, idempotency, audit (PLAT-004).
--
-- Governing sources: 24-EVENT-CATALOG.md, 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md
-- sections 3, 10 and 12, 07-DATA-MODEL.md section 2, contracts/tmanage-core.dbml.
--
-- The three tables here are what makes spec section 3 step 8 possible: "Record audit
-- classification and outbox event in the same transaction." All three are tenant-owned and
-- carry the same layer-1 structure as 0001 — `organization_id CHAR(36) NOT NULL`, a
-- `(organization_id, id)` unique key, and a composite tenant foreign key to the root.
--
-- One deliberate exception is worth naming up front: the outbox *relay* is a cross-tenant
-- reader by design. It claims the oldest unpublished events across all organizations, so
-- its query has no `organization_id` predicate and must use the tenant guard's audited
-- `allowUnscoped` escape hatch. That is the only unscoped read in the platform primitives,
-- and the isolation corpus asserts it is still refused without the escape hatch.

-- ─────────────────────────────────────────────────────────────────────────────
-- Transactional outbox
-- ─────────────────────────────────────────────────────────────────────────────
-- Durable truth for events. Written in the same transaction as the state change that
-- produced it, so an event cannot exist without its cause and a committed change cannot
-- lose its event. Delivery is at-least-once; consumers deduplicate on `id`.

CREATE TABLE outbox_events (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  type            VARCHAR(190) NOT NULL,
  schema_version  INT UNSIGNED NOT NULL DEFAULT 1,
  aggregate_type  VARCHAR(64)  NOT NULL,
  aggregate_id    CHAR(36)     NOT NULL,
  -- Section 10: "Job payloads contain event ID, organization, actor ..., object reference,
  -- and policy version — not raw content." Workers re-resolve the object through scoped
  -- repositories, so this JSON is a reference envelope, never a content copy.
  payload_json    JSON         NOT NULL,
  correlation_id  CHAR(36)     NULL,
  occurred_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- Redelivery backoff. Separate from occurred_at so a retry never rewrites history.
  available_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at    DATETIME(3)  NULL,
  attempts        INT UNSIGNED NOT NULL DEFAULT 0,
  last_error      VARCHAR(1000) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_outbox_events_org_id (organization_id, id),
  -- The relay's claim index. Leading with published_at keeps the unpublished tail small
  -- and contiguous; this is the one index here that does not begin with organization_id,
  -- because the relay is deliberately cross-tenant.
  KEY ix_outbox_events_unpublished (published_at, available_at),
  KEY ix_outbox_events_org_aggregate (organization_id, aggregate_type, aggregate_id),
  CONSTRAINT fk_outbox_events_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Idempotency
-- ─────────────────────────────────────────────────────────────────────────────
-- A retried command must not produce a second effect. The unique key is the whole
-- mechanism: an `INSERT` that collides means the operation is already in flight or done,
-- and the caller replays the stored response instead of executing again.
--
-- The key includes `organization_id` and `actor_user_id` so one tenant's idempotency key
-- can never collide with — or reveal the existence of — another tenant's.

CREATE TABLE idempotency_records (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  actor_user_id   CHAR(36)     NOT NULL,
  operation       VARCHAR(190) NOT NULL,
  -- `key` is reserved in MySQL. Quoted here rather than renamed because the contract in
  -- tmanage-core.dbml names the column `key`.
  `key`           VARCHAR(190) NOT NULL,
  -- Same key, different request body, is a client bug, not a retry. Storing the hash lets
  -- the API answer 409 instead of silently returning someone else's result.
  request_hash    CHAR(64)     NOT NULL,
  status          ENUM('in_progress','succeeded','failed') NOT NULL DEFAULT 'in_progress',
  response_json   JSON         NULL,
  response_status SMALLINT UNSIGNED NULL,
  expires_at      DATETIME(3)  NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at    DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_idempotency_records_org_id (organization_id, id),
  UNIQUE KEY uq_idempotency_records_identity
    (organization_id, actor_user_id, operation, `key`),
  KEY ix_idempotency_records_expiry (expires_at),
  CONSTRAINT fk_idempotency_records_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_idempotency_records_actor
    FOREIGN KEY (actor_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit — append only
-- ─────────────────────────────────────────────────────────────────────────────
-- Section 12 lists the decisions that require audit, and section 10 requires cross-tenant
-- support actions to leave "immutable audit". Immutable is enforced twice, on purpose:
--
--   * Triggers below reject every UPDATE and DELETE. This holds for any credential,
--     including a direct SQL session and the migration user.
--   * scripts/db/users.sql withholds UPDATE and DELETE on this table from the runtime and
--     worker users, so the application physically cannot attempt it.
--
-- Retention/purge is therefore a privileged, separately-credentialed procedure, which is
-- the intent: an audit log an attacker can quietly trim is not an audit log.

CREATE TABLE audit_events (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- Null for system-initiated actions. Both actor columns are recorded when an internal
  -- operator acts on a tenant's behalf (section 12: admin impersonation).
  actor_user_id      CHAR(36)     NULL,
  effective_actor_id CHAR(36)     NULL,
  action             VARCHAR(190) NOT NULL,
  object_type        VARCHAR(64)  NOT NULL,
  object_id          CHAR(36)     NULL,
  result             ENUM('allowed','denied','error') NOT NULL,
  correlation_id     CHAR(36)     NOT NULL,
  -- Section 12: "Denied sensitive attempts are security events with safe metadata."
  -- Safe metadata means identifiers and classifications, never request bodies or content.
  metadata_json      JSON         NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_audit_events_org_id (organization_id, id),
  KEY ix_audit_events_org_time (organization_id, created_at),
  KEY ix_audit_events_org_actor_time (organization_id, actor_user_id, created_at),
  KEY ix_audit_events_org_object (organization_id, object_type, object_id),
  KEY ix_audit_events_org_action_time (organization_id, action, created_at),
  CONSTRAINT fk_audit_events_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_audit_events_actor
    FOREIGN KEY (actor_user_id) REFERENCES users (id),
  CONSTRAINT fk_audit_events_effective_actor
    FOREIGN KEY (effective_actor_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Triggers
-- ─────────────────────────────────────────────────────────────────────────────

DELIMITER $$

CREATE TRIGGER trg_outbox_events_org_immutable
BEFORE UPDATE ON outbox_events FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'outbox_events.organization_id is immutable: spec section 5';
  END IF;
END$$

CREATE TRIGGER trg_idempotency_records_org_immutable
BEFORE UPDATE ON idempotency_records FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'idempotency_records.organization_id is immutable: spec section 5';
  END IF;
END$$

-- Append-only. Not "organization_id is immutable" — no column may change, and no row may
-- be removed. A correction is a new event that references the mistaken one.
CREATE TRIGGER trg_audit_events_no_update
BEFORE UPDATE ON audit_events FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'audit_events is append-only: rows cannot be updated';
END$$

CREATE TRIGGER trg_audit_events_no_delete
BEFORE DELETE ON audit_events FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'audit_events is append-only: rows cannot be deleted';
END$$

DELIMITER ;
