-- 0406_network_access_blocklist_and_source_labels — the attack tracker's two owner actions
-- (SEC-TRACKER, Fable 5.2 review 2026-11-22, gaps 1 and 2: "Block source" and "Mark as known
-- tester"). 0405 is shipped and is not edited (DA-4); this file only adds (DA-6 expand).
--
-- Two GLOBAL tables (an address belongs to no company):
--
-- - `network_access_blocklist` — addresses and CIDRs a platform admin blocked by hand. The sign-in
--   door refuses them as its FIRST layer, whether the anonymous-network policy switch is on or
--   off (`network-access-policy.ts`, reason `source_blocked`). `network_block_ranges` cannot hold
--   them: the worker rewrites that table from the public lists. Owner: identity (network-access).
--   Addresses and CIDRs only (no ASN blocks in v1), at most a /24 (IPv4) or a /48 (IPv6) per row,
--   never overlapping an allowlist entry or the blocking admin's own address (all checked by the
--   API before the insert, 409 otherwise). `value` is the canonical text (`203.0.113.7/32`).
-- - `security_source_labels` — how a source's activity is READ, not whether it gets in:
--   `known_tester` today (room for more labels). Owner: security-signals. A label shows a capsule
--   on the tracker and sorts the source after unlabelled ones of the same severity. It never
--   lowers the stored severity, never silences an alert and never changes the door (a tester
--   must meet the real door; an allowlisted office address is not a tester).
--
-- No person id is stored (the 0405 decision, data minimisation): who added or removed a row is in
-- the platform audit trail (`platform.network_block_added` / `_removed`,
-- `platform.source_label_added` / `_removed`), written in the same transaction. This departs on
-- purpose from the review's `created_by` column; the audit row carries the actor instead.
--
-- Seed: the Instinct AI tester, `48.47.63.166/32`, labelled `known_tester` (Fable ruling, gap 2).
-- It is also on the 0405 allowlist; the two rows are independent.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, CHAR/VARCHAR/DATETIME(3), utf8mb4; no JSON type, no generated column, no CHECK,
-- no functional index. INSERT IGNORE seed: idempotent and re-runnable after a mid-file stop
-- (DA-8: `CREATE TABLE IF NOT EXISTS`).

CREATE TABLE IF NOT EXISTS network_access_blocklist (
  id          CHAR(36)     NOT NULL,
  value       VARCHAR(64)  NOT NULL,
  note        VARCHAR(190) NULL,
  created_at  DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_network_access_blocklist_value (value)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS security_source_labels (
  id          CHAR(36)     NOT NULL,
  value       VARCHAR(64)  NOT NULL,
  label       VARCHAR(32)  NOT NULL,
  note        VARCHAR(190) NULL,
  created_at  DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_security_source_labels_value (value)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO security_source_labels (id, value, label, note, created_at)
VALUES
  ('0193b5a0-0000-7000-8000-00000000b101', '48.47.63.166/32', 'known_tester', 'Instinct AI tester', CURRENT_TIMESTAMP(3));
