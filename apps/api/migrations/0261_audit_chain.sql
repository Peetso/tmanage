-- 0261_audit_chain — tamper evidence for the organization audit trail (56-11 backend half).
--
-- ## What this migration is for
--
-- Every new `audit_events` row is linked to the one before it in the same organization:
-- `row_hash = SHA-256(canonical row || prev_hash)`, and `chain_seq` is its 1-based position in the
-- organization's chain. The writer reads the organization's `audit_heads` row FOR UPDATE inside the
-- audit write's own transaction, so two writers in one organization are serialised and the chain
-- has no forks. Rows written before this migration keep NULL in the three new columns (they are
-- the "legacy" prefix, named by `audit_heads.legacy_last_event_id`); the append-only triggers on
-- `audit_events` (0002) still refuse any UPDATE, so no backfill rewrites history.
--
-- - `audit_events` ADD `chain_seq`, `prev_hash`, `row_hash` (nullable, additive) and an index on
--   `(organization_id, chain_seq)` for the read-only verifier.
-- - `audit_heads` — one row per organization: the current head hash and position. TENANT.
-- - `audit_anchors` — one row per organization per UTC day: the head at the daily anchor run, with
--   an HMAC signature under `AUDIT_ANCHOR_KEY` (NULL when the key is absent). TENANT.
-- - `platform_audit_anchors` — one row per UTC day: a root over that day's organization anchors.
--   GLOBAL (platform evidence, no tenant data beyond hashes).
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain nullable columns, DATE / DATETIME(3), no generated columns, no CHECK, no JSON defaults, no
-- functional indexes, no foreign keys (the 0257 convention), utf8mb4_unicode_ci. Additive only.

ALTER TABLE audit_events
  ADD COLUMN chain_seq BIGINT   NULL,
  ADD COLUMN prev_hash CHAR(64) NULL,
  ADD COLUMN row_hash  CHAR(64) NULL,
  ADD KEY ix_audit_events_org_chain (organization_id, chain_seq);

CREATE TABLE audit_heads (
  id                    CHAR(36)     NOT NULL,
  organization_id       CHAR(36)     NOT NULL,
  chain_seq             BIGINT       NOT NULL DEFAULT 0,
  head_hash             CHAR(64)     NOT NULL,
  last_event_id         CHAR(36)     NULL,
  legacy_last_event_id  CHAR(36)     NULL,
  chain_started_at      DATETIME(3)  NOT NULL,
  updated_at            DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_audit_heads_org_id (organization_id, id),
  UNIQUE KEY uq_audit_heads_org (organization_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_anchors (
  id               CHAR(36)      NOT NULL,
  organization_id  CHAR(36)      NOT NULL,
  day              DATE          NOT NULL,
  head_hash        CHAR(64)      NOT NULL,
  event_count      BIGINT        NOT NULL,
  signature        VARCHAR(512)  NULL,
  created_at       DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_audit_anchors_org_id (organization_id, id),
  UNIQUE KEY uq_audit_anchors_org_day (organization_id, day)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE platform_audit_anchors (
  id          CHAR(36)      NOT NULL,
  day         DATE          NOT NULL,
  root_hash   CHAR(64)      NOT NULL,
  org_count   INT           NOT NULL,
  signature   VARCHAR(512)  NULL,
  created_at  DATETIME(3)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_platform_audit_anchors_day (day)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
