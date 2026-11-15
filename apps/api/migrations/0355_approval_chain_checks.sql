-- 0355_approval_chain_checks — 52-19 approval record chain walk: persisted verdicts.
--
-- - `approval_chain_checks` (TENANT) — one verdict per organization per run of the worker's
--   approval chain walk (`apps/worker/src/jobs/approval-chain-walk.ts`, 03:30 UTC and on boot).
--   Before this table the walk kept its last run in memory, so every worker restart walked again
--   and nothing recorded whether a chain was intact. `status` ok | broken | empty; `break_reason`
--   gap | genesis_mismatch | link_mismatch | hash_mismatch | signature_invalid (closed lists
--   checked in the worker); `break_record_no` is the first record that does not verify. Counts and
--   positions only — never a hash, never record content. A broken verdict is written in the same
--   transaction as its `approval.chain_broken.v1` outbox event, and the 56-23 security signal
--   (`approval_chain_break`) still mails the workspace owners. The newest `checked_at` of any
--   organization is the walk's "last run". The worker prunes verdicts older than 90 days; nothing
--   ever UPDATEs a verdict.
--
-- MariaDB-safe (Hostinger): VARCHAR instead of ENUM, no CHECK, no generated column, no JSON type,
-- no IF NOT EXISTS, DATETIME(3), utf8mb4_unicode_ci. Additive only.
-- Registry: schema.ts (`approvalChainChecks`, TABLES, `ApprovalChainCheckRow`), tenant-guard
-- `TENANT_TABLES`, scripts/db/users.sql (52-19 chain walk block), docs/security/data-inventory.md;
-- the migrator is directory-driven.

CREATE TABLE approval_chain_checks (
  id              CHAR(36)      NOT NULL,
  organization_id CHAR(36)      NOT NULL,
  checked_at      DATETIME(3)   NOT NULL,
  status          VARCHAR(16)   NOT NULL,
  records         INT UNSIGNED  NOT NULL DEFAULT 0,
  break_record_no INT UNSIGNED  NULL,
  break_reason    VARCHAR(32)   NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_acc_org_id (organization_id, id),
  KEY ix_acc_org_checked (organization_id, checked_at),
  KEY ix_acc_checked (checked_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
