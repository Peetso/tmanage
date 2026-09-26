-- 0038_decision_supersessions — the decision-lifecycle write boundary (DEC-01-b / DEC-02, x117).
--
-- Migration number: the highest applied migration on this branch's base (x113) is 0037_decisions.
-- The migrator applies files in ascending numeric order and a gap is not an error (it rejects only
-- a NEW file numbered *below* an applied one), so 0038 on top of 0037 is correct on this base. If
-- integration renumbers the reservations below 0037, the integrator renumbers this file with them;
-- nothing here depends on the literal 0038 beyond the filename.
--
-- Governing sources: 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §Decisions DEC-01 (status/owner/effective
-- date) and DEC-02 (decision detail — supersede / Work Story); 23-ERD-AND-STATE-MACHINES §2
-- (`PROJECT ||--o{ …` project-owned records); 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`); 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- 0037 (x113) shipped the register: a decision is authored `proposed` and read, and its
-- `trg_decisions_immutable` trigger refused *every* UPDATE, because that slice had no edit surface.
-- Its header promised that "when the decision lifecycle lands (status transitions, supersede edges
-- — NEXT-SCOPES-9) it arrives with the code that writes it and this trigger is relaxed to the
-- columns that may then change". This is that slice. It does two things:
--
--   1. Creates `decision_supersessions`: the chain edge that records *by which* decision a decision
--      was superseded. 0037 has the `superseded` status value but nothing that says what superseded
--      it; without this edge "superseded" is a dead end.
--   2. Relaxes `trg_decisions_immutable` to a column-pinning trigger (the pattern
--      `trg_file_versions_immutable`, 0018, established): `status` may change — that is the whole
--      lifecycle, `proposed → accepted` on accept and `→ superseded` on supersede — and every other
--      column is pinned at the engine. A decision's identity, its project, its optional meeting, its
--      words, who decided it and when, and its creation instant can never be rewritten by any
--      credential, exactly as before; only where it sits in its lifecycle moves.
--
-- ## Why the edge is its own table, tenant-scoped and composite-keyed on both ends
--
-- A supersession is a relationship between two decisions, so it is a row of its own, not a column on
-- either decision. Both ends are bound to the acting tenant by a composite foreign key:
-- `fk_decision_supersessions_decision_tenant` binds `(organization_id, decision_id)` and
-- `fk_decision_supersessions_by_tenant` binds `(organization_id, superseded_by_decision_id)`, each
-- to `decisions (organization_id, id)`. A cross-tenant pair does not exist even when both ids exist
-- individually, so a decision can never be superseded by — or supersede — another tenant's decision
-- at the engine. The service resolves both ids tenant- and project-scoped before the write (the
-- Known-trap order), and these keys are the layer beneath that resolution.
--
-- `uq_decision_supersessions_org_decision` makes a decision supersedable at most once: a second edge
-- naming the same superseded `decision_id` is refused, matching the one-way `→ superseded` status
-- flip. `chk_decision_supersessions_not_self` refuses an edge whose two ends are the same decision —
-- a decision cannot supersede itself — as defence in depth beneath the service's own self-supersede
-- check (MySQL 8 enforces CHECK; 0026 set the precedent in this tree).

CREATE TABLE decision_supersessions (
  id                          CHAR(36)    NOT NULL,
  organization_id             CHAR(36)    NOT NULL,
  -- The decision that was superseded. Its `status` is flipped to `superseded` in the same txn.
  decision_id                 CHAR(36)    NOT NULL,
  -- The decision that supersedes it — the "by which" 0037 could not record.
  superseded_by_decision_id   CHAR(36)    NOT NULL,
  -- The person who recorded the supersession — the service passes `context.userId`.
  created_by                  CHAR(36)    NOT NULL,
  created_at                  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_decision_supersessions_org_id (organization_id, id),
  -- A decision is superseded at most once; the one-way status flip has one recorded cause.
  UNIQUE KEY uq_decision_supersessions_org_decision (organization_id, decision_id),
  -- The index the detail read walks to find "who superseded me" and "what did I supersede",
  -- leading with `organization_id` per 07-DATA-MODEL §9.
  KEY ix_decision_supersessions_org_by (organization_id, superseded_by_decision_id),
  CONSTRAINT fk_decision_supersessions_decision_tenant
    FOREIGN KEY (organization_id, decision_id) REFERENCES decisions (organization_id, id),
  CONSTRAINT fk_decision_supersessions_by_tenant
    FOREIGN KEY (organization_id, superseded_by_decision_id) REFERENCES decisions (organization_id, id),
  CONSTRAINT fk_decision_supersessions_created_by
    FOREIGN KEY (created_by) REFERENCES users (id),
  -- A decision cannot supersede itself.
  CONSTRAINT chk_decision_supersessions_not_self CHECK (decision_id <> superseded_by_decision_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An edge, once recorded, is immutable: it is the register's record that one decision superseded
-- another. The trigger refuses every UPDATE at the engine, the reason `decisions` (0037) and the
-- append-only ledgers carry it — a direct SQL session bypasses the application layers.
DELIMITER $$

CREATE TRIGGER trg_decision_supersessions_immutable
BEFORE UPDATE ON decision_supersessions FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'decision_supersessions rows are immutable';
END$$

DELIMITER ;

-- Relax the decisions immutability trigger to a column-pinning one (the 0018 pattern): the lifecycle
-- writes `status` and nothing else. Identity, project, the optional meeting link, the decision's
-- words, who decided it and when, and its creation instant are all pinned — a decision's substance
-- is still immutable at the engine, only its lifecycle position may move. `meeting_id` is nullable,
-- so it is compared with the null-safe `<=>`; every other pinned column is NOT NULL.
DROP TRIGGER IF EXISTS trg_decisions_immutable;

DELIMITER $$

CREATE TRIGGER trg_decisions_immutable
BEFORE UPDATE ON decisions FOR EACH ROW
BEGIN
  IF NEW.id <> OLD.id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'decisions.id is immutable';
  END IF;
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'decisions.organization_id is immutable';
  END IF;
  IF NEW.project_id <> OLD.project_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'decisions.project_id is immutable';
  END IF;
  IF NOT (NEW.meeting_id <=> OLD.meeting_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'decisions.meeting_id is immutable';
  END IF;
  IF NEW.title <> OLD.title THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'decisions.title is immutable';
  END IF;
  IF NEW.statement <> OLD.statement THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'decisions.statement is immutable';
  END IF;
  IF NEW.decided_by <> OLD.decided_by THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'decisions.decided_by is immutable';
  END IF;
  IF NEW.decided_at <> OLD.decided_at THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'decisions.decided_at is immutable';
  END IF;
  IF NEW.created_at <> OLD.created_at THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'decisions.created_at is immutable';
  END IF;
END$$

DELIMITER ;
