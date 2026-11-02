-- 0290_timesheets — 52-02 timesheets (backend) and the approval half of 52-03 (R16 slice a).
--
-- ## What this migration is for
--
-- A member opens their week, fixes the numbers, files the unsorted minutes under the right task and
-- submits; a manager approves the week or asks for changes. One new table:
--
-- - `timesheets` (TENANT, new) — one week of one membership. `period_start` / `period_end` are the
--   seven days that start on the organization's `org_finance_profiles.week_start` (0260); one row per
--   organization, membership and `period_start` (the lazy insert of `GET …/timesheets/mine` races on
--   that key and the loser reads the winner's row). `state` is `open` | `submitted` | `approved` |
--   `changes_requested`, a closed list checked in `modules/time/timesheets-rules.ts`.
--   `submitted_at` stamps the submit; `decided_by` / `decided_at` / `decision_note` stamp the
--   approve or the request for changes (the note, 3..500 characters, only on the latter).
--   `approval_id` is reserved for the `approvals` aggregate (52-03 later; NULL until then).
--   `edited_by_manager` is set when a manager edits somebody else's week, so the member sees it.
--   `total_minutes` / `billable_minutes` are recomputed by a SUM in the same transaction as every
--   entry change (no trigger, no generated column). `version` is the optimistic-concurrency counter
--   of the batch edit (409 on a stale one).
--
-- Entries stay in `work_item_time_logs`: its `timesheet_id` (0265) names the sheet. No foreign key
-- from it (the 0257 rule: the service checks the id tenant-scoped before it stamps it).
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- Plain columns, DATE / DATETIME(3), composite tenant keys, no generated columns, no CHECK, no JSON,
-- no functional indexes, utf8mb4_unicode_ci; the trigger in a DELIMITER $$ block as 0283 / 0288.
--
-- ## Grants (scripts/db/users.sql, 0290 block)
--
-- `tmanage_app`: SELECT, INSERT, UPDATE on `timesheets` (no DELETE: a week is history).
-- `tmanage_worker`: nothing.

CREATE TABLE timesheets (
  id                 CHAR(36)        NOT NULL,
  organization_id    CHAR(36)        NOT NULL,
  -- The membership whose week this is.
  membership_id      CHAR(36)        NOT NULL,
  -- The first and the last day of the week (inclusive), seven days apart.
  period_start       DATE            NOT NULL,
  period_end         DATE            NOT NULL,
  -- open | submitted | approved | changes_requested (checked in the application).
  state              VARCHAR(16)     NOT NULL DEFAULT 'open',
  submitted_at       DATETIME(3)     NULL,
  -- Reserved: the `approvals` row that will govern the week (52-03 later).
  approval_id        CHAR(36)        NULL,
  -- The membership that approved the week or asked for changes, and when.
  decided_by         CHAR(36)        NULL,
  decided_at         DATETIME(3)     NULL,
  -- Why changes were asked for (3..500 characters, checked in the application).
  decision_note      VARCHAR(500)    NULL,
  edited_by_manager  TINYINT(1)      NOT NULL DEFAULT 0,
  total_minutes      INT             NOT NULL DEFAULT 0,
  billable_minutes   INT             NOT NULL DEFAULT 0,
  version            BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at         DATETIME(3)     NOT NULL,
  updated_at         DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_timesheets_org_id (organization_id, id),
  UNIQUE KEY uq_timesheets_member_period (organization_id, membership_id, period_start),
  KEY ix_timesheets_org_period_state (organization_id, period_start, state),
  CONSTRAINT fk_timesheets_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

-- The tenant (ADR-0001 layer 1), the owner and the week a row stands for never move.
CREATE TRIGGER trg_timesheets_org_immutable
BEFORE UPDATE ON timesheets FOR EACH ROW
BEGIN
  IF NOT (NEW.organization_id <=> OLD.organization_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'timesheets.organization_id is immutable';
  END IF;
  IF NOT (NEW.membership_id <=> OLD.membership_id)
     OR NOT (NEW.period_start <=> OLD.period_start) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'timesheets.membership_id and period_start are immutable';
  END IF;
END$$

DELIMITER ;
