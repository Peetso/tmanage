-- 0249_field_cipher_key_rotations — the FieldCipher re-encrypt job's ledger (56-02).
--
-- ## What this migration is for
--
-- Every recoverable secret is stored as a self-describing `fc1.<purpose>.<keyId>.…` envelope
-- (packages/domain/src/security/field-cipher.ts). Rotating a key is: add the new key to
-- FIELD_CIPHER_KEYS, deploy, queue a rotation for a purpose, let the worker
-- (apps/worker/src/jobs/field-cipher-rotation.ts) re-encrypt that purpose's column in 500-row
-- batches, check rows_done + rows_skipped + rows_failed = rows_total, and drop the old key at the
-- next deploy. One row here per rotation. `last_row_id` is the resume point: a worker killed
-- mid-run leaves the row `running` with a stale `heartbeat_at`, and the next worker picks it up
-- from there. Statuses (VARCHAR, closed list in TypeScript): queued, running, done, failed.
--
-- The plan's "widen the four *_enc columns to TEXT" needs no statement: storage_connections and
-- calendar_connections.refresh_token_enc are already TEXT, and an fc1 MFA envelope (about 100
-- characters) fits user_mfa_factors.secret VARCHAR(255).
--
-- ## Global table (NON_TENANT_TABLES)
--
-- A rotation spans every organization; it holds counts and key ids, never a key or a secret.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, literal defaults or CURRENT_TIMESTAMP(3), no generated columns, no CHECK,
-- no functional index, utf8mb4_unicode_ci. Additive only.

CREATE TABLE key_rotations (
  id            CHAR(36)     NOT NULL,
  purpose       VARCHAR(32)  NOT NULL,
  from_key_id   VARCHAR(16)  NULL,
  to_key_id     VARCHAR(16)  NOT NULL,
  status        VARCHAR(16)  NOT NULL DEFAULT 'queued',
  rows_total    INT          NOT NULL DEFAULT 0,
  rows_done     INT          NOT NULL DEFAULT 0,
  rows_skipped  INT          NOT NULL DEFAULT 0,
  rows_failed   INT          NOT NULL DEFAULT 0,
  last_row_id   CHAR(36)     NULL,
  requested_by  CHAR(36)     NULL,
  error         VARCHAR(500) NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at    DATETIME(3)  NULL,
  heartbeat_at  DATETIME(3)  NULL,
  finished_at   DATETIME(3)  NULL,
  PRIMARY KEY (id),
  KEY ix_key_rotations_status (status, created_at),
  KEY ix_key_rotations_purpose (purpose, created_at),
  CONSTRAINT fk_key_rotations_user FOREIGN KEY (requested_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
