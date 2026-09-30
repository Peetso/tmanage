-- 0183_approval_steps — an ordered, sequential approval chain over one approval (Requests,
-- decisions & approvals, module §Requests; x315). Extends the single-decision approval (FR-05,
-- 0027) with a multi-step flow: each step names an approver role (and optionally a specific user)
-- at a fixed position, and the chain advances by recording one step decision at a time.
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Requests, decisions & approvals
-- (multi-step approval); 12-PERMISSION-MATRIX §Approvals; 07-DATA-MODEL §9 (index prefixes lead
-- with `organization_id`); 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## Migration number
--
-- Pass 26 reserves 0174–0201 in slice-id order; x315's reservation is 0183 (pass26-queue header
-- migration map). The migrator applies files in ascending numeric order and a gap is not an error,
-- so nothing here depends on the literal 0183 beyond the filename.
--
-- ## Distinct from approval_delegations
--
-- A delegation (x300) records *who may act* on an approval. This is a different aggregate: the
-- ordered *chain itself* — the positions, their approver roles, and each step's own decision. The
-- two never share a row.
--
-- ## Org-scoped, keyed to its approval within the tenant
--
-- A step belongs to the organization and to one approval. The approval reference is the composite
-- `(organization_id, approval_id)` foreign key onto `approvals (organization_id, id)` — the unique
-- key 0027 carries precisely so a child cannot reference an approval across a tenant boundary.
-- There is no bare `approval_id` foreign key: a cross-tenant path must be impossible by
-- construction.
--
-- ## The active step and the state
--
-- `state` is a short `VARCHAR` validated against a fixed application allowlist (`pending` |
-- `approved` | `rejected`) before any write — the same division `approvals.state` uses, so the set
-- can grow without an `ALTER TABLE`. The *active* step is the lowest `position` still `pending`;
-- deciding a non-active or already-decided step is a 409 the application refuses. `position` is
-- unique within an approval so two steps cannot claim the same slot.
--
-- ## Identity is immutable; the decision is not
--
-- `organization_id`, `approval_id`, `position`, `approver_role` and `approver_user_id` are what a
-- step *is*; the `BEFORE UPDATE` trigger holds them at the engine (ADR-0001 layers 3 and 4 are
-- application-side and a direct SQL session bypasses both), the reason every identity trigger in
-- this schema exists. `state`, `decided_by` and `decided_at` are the decision the app records, so
-- they are left editable — the app is granted INSERT and UPDATE, and the trigger is the
-- engine-level backstop that a decision can never rewrite a step's identity.

CREATE TABLE approval_steps (
  id                CHAR(36)    NOT NULL,
  organization_id   CHAR(36)    NOT NULL,
  -- The approval this step belongs to. Composite-keyed to the approval within the same tenant below.
  approval_id       CHAR(36)    NOT NULL,
  -- The step's slot in the chain — a non-negative index the application bounds. Unique per approval.
  position          INT UNSIGNED NOT NULL,
  -- The approver role expected at this step. A bounded string the application size-checks.
  approver_role     VARCHAR(64) NOT NULL,
  -- Optionally, the specific user expected to decide this step. NULL means "any holder of the role".
  approver_user_id  CHAR(36)    NULL,
  -- The step's own decision state. Validated against a fixed application allowlist (`pending` |
  -- `approved` | `rejected`) before any write; the column only ever holds a known token.
  state             VARCHAR(16) NOT NULL DEFAULT 'pending',
  -- Who recorded the decision, and when. NULL while the step is still pending.
  decided_by        CHAR(36)    NULL,
  decided_at        DATETIME(3) NULL,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries.
  UNIQUE KEY uq_approval_steps_org_id (organization_id, id),
  -- One step per position within an approval: a duplicate position is impossible at the engine as
  -- well as refused (400) by the application. Leads with `organization_id` per 07-DATA-MODEL §9.
  UNIQUE KEY uq_approval_steps_org_approval_position (organization_id, approval_id, position),
  CONSTRAINT fk_approval_steps_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The approval, referenced through the composite tenant key so a step cannot point at another
  -- studio's approval. Matches the `(organization_id, id)` unique key 0027 declares for this purpose.
  CONSTRAINT fk_approval_steps_approval
    FOREIGN KEY (organization_id, approval_id) REFERENCES approvals (organization_id, id),
  -- The optional expected approver. References users (id) without organization_id because a user is
  -- not tenant-owned — the same shape `approvals.decided_by_user_id` (0027) uses.
  CONSTRAINT fk_approval_steps_approver_user
    FOREIGN KEY (approver_user_id) REFERENCES users (id),
  -- The actor who decided the step. Same non-tenant reference to users (id).
  CONSTRAINT fk_approval_steps_decided_by
    FOREIGN KEY (decided_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A step's tenant, approval, position and approver are what it *is* and are immutable, the reason
-- every identity trigger in this schema gives. `state`, `decided_by` and `decided_at` are the
-- decision the application records and are left editable at the engine; this trigger is the
-- engine-level backstop that a decision (or any other credential) can never rewrite identity.
DELIMITER $$

CREATE TRIGGER trg_approval_steps_immutable
BEFORE UPDATE ON approval_steps FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'approval_steps.organization_id is immutable';
  END IF;
  IF NEW.approval_id <> OLD.approval_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'approval_steps.approval_id is immutable';
  END IF;
  IF NEW.position <> OLD.position THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'approval_steps.position is immutable';
  END IF;
  IF NEW.approver_role <> OLD.approver_role THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'approval_steps.approver_role is immutable';
  END IF;
  IF NOT (NEW.approver_user_id <=> OLD.approver_user_id) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'approval_steps.approver_user_id is immutable';
  END IF;
END$$

DELIMITER ;
