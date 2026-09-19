-- 0021_usage_ledger_entries — the append-only storage usage ledger (USAGE-001 slice 2).
--
-- Governing sources: 49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY §5 ("Maintain an append-only
-- usage ledger plus reconciled counters … record: organization, byte delta, reason, source
-- event, occurred time, and idempotency key"); 24-EVENT-CATALOG §2 ("Producer writes state
-- and outbox event atomically"); migration 0015 (`usage_counters`, whose moves this ledger
-- records) and migration 0002 (`outbox_events`, the producing event each row points at).
--
-- ## What this table is
--
-- One immutable row per counter move. Every reserve, commit and release on `usage_counters`
-- is a signed `delta` against one `counter` dimension, written inside the same transaction
-- that moved the counter and appended the outbox event — so a counter move without a ledger
-- row, or a ledger row without the event that caused it, is impossible. Summing `delta` per
-- `(organization_id, counter)` reproduces `usage_counters.used_value` / `reserved_value`;
-- the reconciliation slice (USAGE-001 slice 3) is what compares that sum against provider
-- inventory. This slice only records; it never reads.
--
-- ## The `counter` divergence (Q8, delegated to the orchestrator)
--
-- 49 §5 lists "asset/version, storage class" among the fields. This slice meters exactly one
-- metric (`storage.bytes`, migration 0015) split across the two counter dimensions the
-- quota primitive already keeps — `used` and `reserved` — so the ledger carries a `counter`
-- column naming which dimension moved rather than a storage-class taxonomy no code produces
-- yet. Recorded as a divergence in docs/implementation-status.md, not in docs/planning.
--
-- ## Append-only by construction and by privilege
--
-- No `updated_at`, no `version`, no soft-delete column: a row, once written, is history. The
-- runtime credential (`scripts/db/users.sql`) holds INSERT and the database-wide SELECT and
-- nothing else on this table — no UPDATE, no DELETE — so the application cannot rewrite or
-- erase a ledger entry even by mistake. That is the same arrangement `audit_events` and
-- `session_refresh_tokens` have, and for the same reason: a bill you can quietly edit is not
-- a ledger.
--
-- ## Idempotency
--
-- `idempotency_key` is `<upload_session_id>:<reason>`, unique per organization. A replay of
-- the same counter move (the producer INSERTs with `ON DUPLICATE KEY UPDATE` a no-op) writes
-- nothing and does not raise, so at-least-once delivery upstream cannot double-count a move.

CREATE TABLE usage_ledger_entries (
  id              CHAR(36)          NOT NULL,
  organization_id CHAR(36)          NOT NULL,
  -- Which dimension of the metric moved. Fixed vocabulary (`USAGE_LEDGER_COUNTERS`); a new
  -- metric (seats, active projects) becomes rows on `usage_counters`, not a value here.
  counter         ENUM('used','reserved') NOT NULL,
  -- Signed: a reservation is positive, its release or conversion negative. `usage_counters`
  -- columns are BIGINT UNSIGNED because a counter can never be negative; the ledger that
  -- explains how a counter reached its value must be able to record a decrease.
  delta           BIGINT            NOT NULL,
  -- Why the move happened: `reserve`, `commit`, `commit_release`, `cancelled`, `expired`,
  -- `failed`. A closed vocabulary in TypeScript, VARCHAR here (metric_key's precedent) so a
  -- later slice's reason is a value, not a schema change.
  reason          VARCHAR(32)       NOT NULL,
  -- `<upload_session_id>:<reason>`. Unique per organization below: a replayed move is a
  -- no-op, not a second row.
  idempotency_key VARCHAR(96)       NOT NULL,
  -- The `outbox_events` row this move produced — the join in 49 §5's "source event". The
  -- composite foreign key binds it to the same tenant, so a ledger row can only ever cite an
  -- event of its own organization.
  source_event_id CHAR(36)          NOT NULL,
  created_at      DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_usage_ledger_entries_org_id (organization_id, id),
  -- The idempotency guarantee, tenant-scoped: two organizations may share an upload-session
  -- id shape without their ledgers colliding.
  UNIQUE KEY uq_usage_ledger_entries_org_idem (organization_id, idempotency_key),
  -- Leads the source foreign key and answers "every ledger row for this event".
  KEY ix_usage_ledger_entries_org_source (organization_id, source_event_id),
  CONSTRAINT fk_usage_ledger_entries_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_usage_ledger_entries_source
    FOREIGN KEY (organization_id, source_event_id)
    REFERENCES outbox_events (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
