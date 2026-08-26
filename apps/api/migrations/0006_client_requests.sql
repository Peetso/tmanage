-- 0006_client_requests — the thing a client can finally *do* (REQ-001).
--
-- Governing sources: 23-ERD-AND-STATE-MACHINES.md §6 (the lifecycle and its requirements),
-- 22-SCREEN-BY-SCREEN-SPEC.md §6 CL-06 ("Title, category, description, urgency reason, desired
-- date, files. Confirmation states date is uncommitted."), 11-USER-STORIES-ACCEPTANCE.md US-B01,
-- 12-PERMISSION-MATRIX.md §2 ("Submit client request" — every client role, no internal role),
-- 21-REQUIREMENTS-TRACEABILITY.md FR-01, 07-DATA-MODEL.md §9 (index prefixes).
--
-- ## Why this table exists at all
--
-- CLIENT-002 gave a client a portal to read. `client_request.submit` is in every client role's
-- ceiling and it is the one capability all four of them share — and until this migration there
-- was nothing to submit to. A client could be shown work and could not answer.
--
-- ## The two dates are the whole of US-B01
--
-- `desired_at` is what the client asked for. `committed_at` is what the studio agreed to, and
-- it can only be written by an acceptance. They are separate columns rather than one column
-- with a meaning that changes, because US-B01's acceptance criterion is "visible acknowledgement
-- that date is requested, not committed" — and a single column would make that acknowledgement
-- a UI convention rather than a fact about the row. A request that is accepted with no date
-- keeps the client's `desired_at` and records `commitment = 'unscheduled'`, which is §6's
-- "committed date or explicit unscheduled state" stored as exactly that choice.
--
-- ## The triage columns can only be written by a transition
--
-- `clarification_question`, `client_visible_reason`, `client_safe_scope_summary`, `commitment`,
-- `committed_at` and `linked_work_item_id` are the named facts §6 attaches to particular moves:
-- a question to ask for clarification, a client-safe reason to defer or decline, and a scope
-- summary, a commitment and linked work to accept. `clientRequestStateMachine` in
-- `packages/domain` already refuses a move that arrives without them, and the repository writes
-- them in the same statement as the state. There is no update path that sets a decline reason
-- without declining, so a reason in this table is evidence that the decision was made.
--
-- ## `state` has no DEFAULT, deliberately
--
-- `work_items.state` has `DEFAULT 'triage'` in `0001_tenancy.sql` and `triage` is not a
-- work-item state at all — it belongs to *this* lifecycle. That defect is latent because every
-- writer names the column explicitly. The lesson is that a default is a second opinion about a
-- lifecycle, free to be wrong and invisible when it is, so this column has none: under
-- `STRICT_ALL_TABLES` an insert that forgets the state fails rather than inventing one.
--
-- ## No `deleted_at`, and no DELETE grant
--
-- Every other aggregate in this system is soft-deleted. A client request is not deletable at
-- all, and §6 is why: `withdrawn` is a state the *client* reaches, and it is the only way a
-- request leaves the queue without an answer. A studio-side delete would let the agency make a
-- client's request disappear with no record that it was ever made, which is the one thing a
-- request log exists to prevent.

CREATE TABLE client_requests (
  id                        CHAR(36)     NOT NULL,
  organization_id           CHAR(36)     NOT NULL,
  -- The project the request is against. It must be one shared with the client organization
  -- below; `project_clients` is what makes that true and the service checks it before insert.
  project_id                CHAR(36)     NOT NULL,
  -- Which client submitted it. NOT NULL: a request always belongs to a client organization,
  -- and this column is what stops Atlas reading Meridian's requests in the same studio.
  client_organization_id    CHAR(36)     NOT NULL,
  submitted_by_user_id      CHAR(36)     NOT NULL,
  -- CL-06's fields, in CL-06's order.
  title                     VARCHAR(300) NOT NULL,
  -- CL-06 says "category" and no document in the pack enumerates the categories. A closed set
  -- invented here would be a vocabulary no screen agreed to, so this is free text with a
  -- default, and the gap is recorded in docs/implementation-status.md rather than guessed at.
  category                  VARCHAR(64)  NOT NULL DEFAULT 'general',
  description               TEXT         NOT NULL,
  -- Optional: a client explaining *why* something is urgent. Prose, and it stays prose — it is
  -- never copied into audit metadata, which admits identifiers and classifications only.
  urgency_reason            VARCHAR(500) NULL,
  -- Requested, never committed. See the note above.
  desired_at                DATETIME(3)  NULL,
  -- §6's lifecycle. No DEFAULT — see the note above.
  state                     VARCHAR(32)  NOT NULL,
  -- The facts §6 requires, each written only by the transition that requires it.
  clarification_question    TEXT         NULL,
  client_visible_reason     VARCHAR(1000) NULL,
  client_safe_scope_summary TEXT         NULL,
  commitment                ENUM('committed','unscheduled') NULL,
  committed_at              DATETIME(3)  NULL,
  -- REQ-002 creates the work and links it in one transaction. REQ-001 stores the link and
  -- proves it names work inside this tenant; it does not create anything.
  linked_work_item_id       CHAR(36)     NULL,
  -- Optimistic concurrency (spec §3 step 7). A request is exactly the row a client and a
  -- manager touch at the same time — the client withdrawing while the manager triages — so it
  -- carries a real version column rather than leaning on `updated_at`.
  version                   BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at                DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                         ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_client_requests_org_id (organization_id, id),
  -- 07-DATA-MODEL §9: every composite index begins with organization_id, because every
  -- legitimate query does too. The two below are the two lists that exist: the studio's triage
  -- queue for a project, and one client organization's own requests.
  KEY ix_client_requests_org_project_state (organization_id, project_id, state, created_at),
  KEY ix_client_requests_org_client_state
    (organization_id, client_organization_id, state, created_at),
  CONSTRAINT fk_client_requests_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_client_requests_client_org_tenant
    FOREIGN KEY (organization_id, client_organization_id)
    REFERENCES client_organizations (organization_id, id),
  -- Composite, and nullable: InnoDB does not check a composite foreign key when any of its
  -- columns is NULL, so an unlinked request is unconstrained and a linked one cannot name
  -- another tenant's work item.
  CONSTRAINT fk_client_requests_work_item_tenant
    FOREIGN KEY (organization_id, linked_work_item_id)
    REFERENCES work_items (organization_id, id),
  CONSTRAINT fk_client_requests_submitted_by
    FOREIGN KEY (submitted_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Two rules at the engine, for the reason every other trigger in this schema exists: ADR-0001
-- layers 3 and 4 are application-side, and a direct SQL session bypasses both.
--
-- 1. **Identity is immutable.** `organization_id` for the reason it is immutable everywhere —
--    an UPDATE that moved one would move a request between customers. `project_id`,
--    `client_organization_id` and `submitted_by_user_id` for a sharper reason: they are what
--    the request *is*. Re-pointing a submitted request at another client's project would
--    silently reassign an answer, and there is no application code that has a reason to.
--
-- 2. **A commitment is coherent or it does not exist.** §6 asks for "committed date or explicit
--    unscheduled state", which is a choice between two things and not a pair of independent
--    nullable columns. Without this, `commitment = 'committed'` with a NULL date would read as
--    a promise nobody made, and a date with no commitment would read as one nobody recorded.
DELIMITER $$

CREATE TRIGGER trg_client_requests_commitment_coherent
BEFORE INSERT ON client_requests FOR EACH ROW
BEGIN
  IF NEW.commitment = 'committed' AND NEW.committed_at IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_requests.commitment = committed requires committed_at';
  END IF;
  IF NEW.commitment <> 'committed' AND NEW.committed_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_requests.committed_at requires commitment = committed';
  END IF;
  IF NEW.commitment IS NULL AND NEW.committed_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_requests.committed_at requires commitment = committed';
  END IF;
END$$

CREATE TRIGGER trg_client_requests_immutable
BEFORE UPDATE ON client_requests FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_requests.organization_id is immutable';
  END IF;
  IF NEW.project_id <> OLD.project_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_requests.project_id is immutable';
  END IF;
  IF NEW.client_organization_id <> OLD.client_organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_requests.client_organization_id is immutable';
  END IF;
  IF NEW.submitted_by_user_id <> OLD.submitted_by_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_requests.submitted_by_user_id is immutable';
  END IF;
  IF NEW.commitment = 'committed' AND NEW.committed_at IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_requests.commitment = committed requires committed_at';
  END IF;
  IF NEW.commitment <> 'committed' AND NEW.committed_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_requests.committed_at requires commitment = committed';
  END IF;
  IF NEW.commitment IS NULL AND NEW.committed_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'client_requests.committed_at requires commitment = committed';
  END IF;
END$$

DELIMITER ;
