-- 0235_approval_reviewer_decisions — one row per reviewer's decision on a multi-reviewer approval
-- (wave 9 security lane S5, audit run 1 finding F15).
--
-- An approval names its reviewers (`approvals.reviewer_ids`) and a policy (`all_required`,
-- `any_one`, `ordered_sequence`; 23-ERD §8 "aggregate outcome follows policy"). Before this table
-- the first permitted reviewer moved the whole approval to a terminal state, so one of several
-- required reviewers could approve alone. Now each reviewer's own decision is recorded here, the
-- application aggregates the rows by the approval's policy (`aggregateApprovalOutcome` in
-- packages/domain), and the approval row moves to `approved` / `changes_requested` only when the
-- aggregate is final.
--
-- One decision per reviewer per approval: the UNIQUE key refuses a second row at the engine as well
-- as in the application. Org-scoped like every tenant table: the `(organization_id, id)` unique key,
-- the organization FK, and the approval referenced through the composite tenant key onto
-- `approvals (organization_id, id)` so a decision can never point at another studio's approval.
--
-- Written by the API credential with **INSERT only** (scripts/db/users.sql): a reviewer's decision
-- is evidence and is never edited or removed. The feedback text stays on the approval row (the
-- final decision); this row holds only who decided what and when.
--
-- MariaDB-safe: plain columns, no CHECK, no generated column, no partial index, no JSON default.

CREATE TABLE approval_reviewer_decisions (
  id                CHAR(36)    NOT NULL,
  organization_id   CHAR(36)    NOT NULL,
  approval_id       CHAR(36)    NOT NULL,
  reviewer_user_id  CHAR(36)    NOT NULL,
  outcome           ENUM('approved', 'changes_requested') NOT NULL,
  decided_at        DATETIME(3) NOT NULL,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_approval_reviewer_decisions_org_id (organization_id, id),
  UNIQUE KEY uq_approval_reviewer_decisions_reviewer (organization_id, approval_id, reviewer_user_id),
  CONSTRAINT fk_approval_reviewer_decisions_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_approval_reviewer_decisions_approval
    FOREIGN KEY (organization_id, approval_id) REFERENCES approvals (organization_id, id),
  CONSTRAINT fk_approval_reviewer_decisions_reviewer
    FOREIGN KEY (reviewer_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
