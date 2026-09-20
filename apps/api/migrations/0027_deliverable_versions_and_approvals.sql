-- 0027_deliverable_versions_and_approvals — the immutable-decision heart of FR-05 (x92).
--
-- Governing sources: 09-MVP-PRD.md §FR-05 ("Reviewer sees governed version, criteria, context,
-- and prior feedback. Approve creates immutable decision. Request changes requires feedback.
-- Changed governed content creates new version and invalidates pending approval."),
-- 23-ERD-AND-STATE-MACHINES.md §8 (the approval lifecycle and its named requirements),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md §8 (a decision is permitted only when the
-- content hash equals the governed version and the actor is a current reviewer),
-- 27-TEST-CATALOG.md INT-16/INT-17, 11-USER-STORIES-ACCEPTANCE.md US-C03,
-- 07-DATA-MODEL.md §9 (every composite index begins with organization_id).
--
-- ## Two tables, one binding
--
-- `deliverable_versions` is the immutable identity of governed content: an exact deliverable at
-- an exact `content_hash`. `approvals` binds one reviewer request to one such version and to the
-- hash captured at request time. Without the version row an approval would be a claim about a
-- mutable thing; with it, "the client approved this" is a claim about exact bytes (see
-- packages/domain/src/value-objects/content-hash.ts).
--
-- ## A version is immutable, and a new one is how governed content changes
--
-- There is no UPDATE path for `deliverable_versions` in the repository and a trigger refuses one
-- at the engine, for the reason every other immutability trigger in this schema exists: ADR-0001
-- layers 3 and 4 are application-side and a direct SQL session bypasses both. §FR-05's "changed
-- governed content creates new version" is why a change is an INSERT of a new row rather than an
-- edit of this one — the old bytes, and the hash the reviewer saw, survive.
--
-- ## `approvals` is append-only and re-checks the hash inside the decision
--
-- `state` has no DEFAULT, deliberately — the note in 0006_client_requests.sql applies: a default
-- is a second opinion about a lifecycle, free to be wrong and invisible when it is, so under
-- STRICT_ALL_TABLES an insert that forgets the state fails rather than inventing one.
--
-- A decision is append-only: once the approval reaches a terminal state (23-ERD §8:
-- approved / changes_requested / expired / cancelled / invalidated) no further UPDATE is
-- permitted, so a recorded decision cannot be silently overwritten. The service enforces this
-- through `approvalStateMachine`; the trigger below is the same rule at the engine, defence in
-- depth (INT-16 "append-only").
--
-- The hash re-check itself (INT-16/INT-17) is application logic: the decision transaction reads
-- the deliverable's current governed version and, when its `content_hash` no longer equals the
-- one this approval captured, moves the approval to `invalidated` rather than deciding. The
-- engine cannot make that comparison — it does not know which version is "current" — so this
-- migration provides the columns the service compares, not the comparison.

CREATE TABLE deliverable_versions (
  id                        CHAR(36)     NOT NULL,
  organization_id           CHAR(36)     NOT NULL,
  -- Tenant-scoped by project (acceptance 1). Composite FK below makes a cross-tenant project
  -- reference structurally impossible.
  project_id                CHAR(36)     NOT NULL,
  -- The logical deliverable this is a version of. There is no `deliverables` table yet (the
  -- deliverable aggregate is domain-only today — 23-ERD §4), so this is a logical reference, not
  -- a foreign key. The (organization_id, deliverable_id, created_at) index below is how the
  -- service finds a deliverable's current version for the hash re-check.
  deliverable_id            CHAR(36)     NOT NULL,
  -- The immutable identity of the bytes — a lowercase hex SHA-256 digest (content-hash.ts).
  content_hash              CHAR(64)     NOT NULL,
  created_by_user_id        CHAR(36)     NOT NULL,
  created_at                DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The composite unique key an approval's composite foreign key points at, so an approval can
  -- only bind a version from its own tenant.
  UNIQUE KEY uq_deliverable_versions_org_id (organization_id, id),
  -- 07-DATA-MODEL §9: the one list that exists — a deliverable's versions newest-first, which is
  -- how the decision transaction reads the current governed version.
  KEY ix_deliverable_versions_org_deliverable
    (organization_id, deliverable_id, created_at),
  CONSTRAINT fk_deliverable_versions_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_deliverable_versions_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE approvals (
  id                        CHAR(36)     NOT NULL,
  organization_id           CHAR(36)     NOT NULL,
  project_id                CHAR(36)     NOT NULL,
  -- The deliverable under review. Denormalised from the bound version so the current-version
  -- lookup for the hash re-check does not have to join back through it.
  deliverable_id            CHAR(36)     NOT NULL,
  -- Exactly one immutable version, bound at request time (23-ERD §8, FR-05).
  deliverable_version_id    CHAR(36)     NOT NULL,
  -- The hash of that version, captured at request time. Compared against the current governed
  -- version's hash inside the decision transaction (INT-16); never re-derived from the row above,
  -- so a later version change is visible as a mismatch rather than silently followed.
  content_hash              CHAR(64)     NOT NULL,
  -- 23-ERD §8's lifecycle. No DEFAULT — see the note above.
  state                     VARCHAR(32)  NOT NULL,
  -- 23-ERD §8: how multiple reviewers combine (packages/domain ApprovalPolicy).
  policy                    ENUM('all_required','any_one','ordered_sequence') NOT NULL
                                         DEFAULT 'all_required',
  -- The reviewer relation — the real gate (25-AUTH §8, AUTH-08). A JSON array of user ids;
  -- membership in it is what `authorize()` reads as `isAssignedReviewer`. Held on the row rather
  -- than a join table for this first slice: a single decision does not need per-reviewer rows.
  reviewer_ids              JSON         NOT NULL,
  -- The immutable decision — US-C03's actor and time. NULL until the approval is decided; a
  -- trigger refuses the terminal decision states without them.
  decided_by_user_id        CHAR(36)     NULL,
  decided_at                DATETIME(3)  NULL,
  -- FR-05: requesting changes requires feedback. NULL otherwise; the trigger enforces the pair.
  feedback                  TEXT         NULL,
  -- Why a pending approval was invalidated (23-ERD §8) — a governed content change.
  invalidation_reason       VARCHAR(500) NULL,
  -- Optimistic concurrency (spec §3 step 7) and the append-only guard's read-modify-write token.
  version                   BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at                DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                         ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_approvals_org_id (organization_id, id),
  -- 07-DATA-MODEL §9: a deliverable's approvals, and the pending-approval lookup the decision
  -- transaction and any invalidation sweep use.
  KEY ix_approvals_org_deliverable_state
    (organization_id, deliverable_id, state, created_at),
  CONSTRAINT fk_approvals_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  -- The version is bound within the same tenant: the composite target is
  -- deliverable_versions (organization_id, id).
  CONSTRAINT fk_approvals_version_tenant
    FOREIGN KEY (organization_id, deliverable_version_id)
    REFERENCES deliverable_versions (organization_id, id),
  CONSTRAINT fk_approvals_decided_by
    FOREIGN KEY (decided_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

-- A deliverable version is immutable. Its identity-defining columns may never change; §FR-05's
-- "changed governed content creates new version" is an INSERT, never an UPDATE of this row.
CREATE TRIGGER trg_deliverable_versions_immutable
BEFORE UPDATE ON deliverable_versions FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.project_id <> OLD.project_id
     OR NEW.deliverable_id <> OLD.deliverable_id
     OR NEW.content_hash <> OLD.content_hash
     OR NEW.created_by_user_id <> OLD.created_by_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'deliverable_versions rows are immutable';
  END IF;
END$$

-- Three rules at the engine, mirroring the state machine so a direct SQL session cannot step
-- around what the service refuses.
--
-- 1. Identity is immutable. The tenant, the deliverable, the bound version and the captured hash
--    are what the approval *is*; re-pointing any of them would silently reassign a decision.
-- 2. Append-only. Once terminal (23-ERD §8), no further change — a recorded decision is evidence
--    and cannot be overwritten (INT-16).
-- 3. A decision is coherent. approved/changes_requested require an actor and a time (US-C03), and
--    changes_requested additionally requires non-empty feedback (FR-05).
CREATE TRIGGER trg_approvals_guard
BEFORE UPDATE ON approvals FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.project_id <> OLD.project_id
     OR NEW.deliverable_id <> OLD.deliverable_id
     OR NEW.deliverable_version_id <> OLD.deliverable_version_id
     OR NEW.content_hash <> OLD.content_hash THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'approvals identity columns are immutable';
  END IF;
  IF OLD.state IN ('approved','changes_requested','expired','cancelled','invalidated') THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'approvals are append-only: a terminal approval cannot be re-decided';
  END IF;
  IF NEW.state IN ('approved','changes_requested')
     AND (NEW.decided_by_user_id IS NULL OR NEW.decided_at IS NULL) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'a decided approval requires decided_by_user_id and decided_at';
  END IF;
  IF NEW.state = 'changes_requested'
     AND (NEW.feedback IS NULL OR TRIM(NEW.feedback) = '') THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'changes_requested requires non-empty feedback';
  END IF;
END$$

DELIMITER ;
