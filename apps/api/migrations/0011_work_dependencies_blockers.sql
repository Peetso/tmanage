-- 0011_work_dependencies_blockers — the edges between work, and the fact that work is
-- stuck (WORK-003).
--
-- Governing sources: 23-ERD-AND-STATE-MACHINES.md §2 (WORK_ITEM ||--o{ WORK_DEPENDENCY :
-- predecessor; WORK_ITEM ||--o{ WORK_BLOCKER : has) and §1 ("Work owns work
-- items/dependencies/blockers"), 13-ENGINEERING-EXECUTION-SPEC.md §5 (the vertical-slice
-- schema names `work_item_dependencies`), 11-USER-STORIES US-B04 ("blocker has reason,
-- since date, owner/ask; dependency risk updates; resolution records outcome"),
-- 09-MVP-PRD §63 ("Dependencies prevent 'on track' claim when a critical predecessor is
-- late"), 28-SPRINT-TICKETS §5 WORK-003.
--
-- ## A divergence inside the pack, recorded rather than resolved
--
-- `contracts/tmanage-core.dbml` draws neither table, while 13-ENGINEERING §5 puts
-- `work_item_dependencies` in the vertical slice and the ERD draws both relations. The
-- engineering spec and the ERD win here — a scheduled ticket cannot be built against a
-- contract that omits its subject — and the DDL keeps the house shape (canonical CHAR(36),
-- (organization_id, id) unique keys, composite tenant FKs) so the dbml can adopt it
-- verbatim when it catches up. Recorded in docs/implementation-status.md.
--
-- ## A dependency is an immutable edge
--
-- `work_item_id` DEPENDS ON `depends_on_work_item_id` — the successor points at its
-- predecessor, the ERD's arrow read from the other end. An edge is a fact with no fields
-- to edit: re-pointing one would silently change what "on track" means for a row nobody
-- touched, so UPDATE is refused wholesale and correcting an edge is delete-and-add. The
-- DELETE grant exists (planning edges are removable); the removal is audited, because the
-- delete destroys the only record of the edge — `project_membership.revoked`'s reasoning.
--
-- Self-dependency is refused at the engine. Longer cycles cannot be seen from one row, so
-- the *service* refuses them with a recursive walk before inserting; the trigger here is
-- the floor under it, not the whole rule.
--
-- ## A blocker is a ledger with one open entry
--
-- US-B04's "resolution records outcome" makes a blocker two moments: raised (reason, ask,
-- optional owner, since) and resolved (outcome, when, by whom). Rows are never deleted and
-- never rewritten: the one legal update is resolving an open entry, exactly once. "One
-- active blocker per work item" — the machine's own note says leaving `blocked` resolves
-- THE active blocker, singular — is enforced by the engine through `active_item`, a stored
-- generated column that holds the work item id while unresolved and NULL after: the unique
-- key over it admits any number of resolved entries and at most one open one.

CREATE TABLE work_item_dependencies (
  id                       CHAR(36)    NOT NULL,
  organization_id          CHAR(36)    NOT NULL,
  -- The successor: the row whose health this edge informs.
  work_item_id             CHAR(36)    NOT NULL,
  -- The predecessor: the work that must land first.
  depends_on_work_item_id  CHAR(36)    NOT NULL,
  created_by_user_id       CHAR(36)    NOT NULL,
  created_at               DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_work_item_dependencies_org_id (organization_id, id),
  -- One edge per ordered pair. The same pair reversed is a cycle, refused by the service.
  UNIQUE KEY uq_work_item_dependencies_edge
    (organization_id, work_item_id, depends_on_work_item_id),
  -- The reads: a row's predecessors (health), and a row's dependents (impact).
  KEY ix_work_item_dependencies_predecessor
    (organization_id, depends_on_work_item_id),
  CONSTRAINT fk_work_item_dependencies_item_tenant
    FOREIGN KEY (organization_id, work_item_id)
    REFERENCES work_items (organization_id, id),
  CONSTRAINT fk_work_item_dependencies_predecessor_tenant
    FOREIGN KEY (organization_id, depends_on_work_item_id)
    REFERENCES work_items (organization_id, id),
  CONSTRAINT fk_work_item_dependencies_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE work_blockers (
  id                  CHAR(36)      NOT NULL,
  organization_id     CHAR(36)      NOT NULL,
  work_item_id        CHAR(36)      NOT NULL,
  -- US-B04's facts. Sized like client_visible_reason: a sentence, not a document.
  reason              VARCHAR(1000) NOT NULL,
  ask                 VARCHAR(1000) NOT NULL,
  -- Who the ask is on. Nullable: a blocker on "the vendor" names nobody in this system.
  owner_user_id       CHAR(36)      NULL,
  created_by_user_id  CHAR(36)      NOT NULL,
  -- US-B04's "since date".
  created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  resolved_at         DATETIME(3)   NULL,
  resolution          VARCHAR(1000) NULL,
  resolved_by_user_id CHAR(36)      NULL,
  -- The engine's "one open entry": the item id while unresolved, NULL once resolved.
  active_item         CHAR(36) GENERATED ALWAYS AS
    (IF(resolved_at IS NULL, work_item_id, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_work_blockers_org_id (organization_id, id),
  UNIQUE KEY uq_work_blockers_one_active (organization_id, active_item),
  KEY ix_work_blockers_item (organization_id, work_item_id, created_at),
  CONSTRAINT fk_work_blockers_item_tenant
    FOREIGN KEY (organization_id, work_item_id)
    REFERENCES work_items (organization_id, id),
  CONSTRAINT fk_work_blockers_owner
    FOREIGN KEY (owner_user_id) REFERENCES users (id),
  CONSTRAINT fk_work_blockers_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id),
  CONSTRAINT fk_work_blockers_resolved_by
    FOREIGN KEY (resolved_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_work_item_dependencies_no_self
BEFORE INSERT ON work_item_dependencies FOR EACH ROW
BEGIN
  IF NEW.work_item_id = NEW.depends_on_work_item_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'a work item cannot depend on itself';
  END IF;
END$$

CREATE TRIGGER trg_work_item_dependencies_immutable
BEFORE UPDATE ON work_item_dependencies FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'work_item_dependencies rows are immutable: correct an edge by delete and add';
END$$

CREATE TRIGGER trg_work_blockers_resolve_once
BEFORE UPDATE ON work_blockers FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.work_item_id <> OLD.work_item_id
     OR NEW.reason <> OLD.reason
     OR NEW.ask <> OLD.ask
     OR NOT (NEW.owner_user_id <=> OLD.owner_user_id)
     OR NEW.created_by_user_id <> OLD.created_by_user_id
     OR NEW.created_at <> OLD.created_at THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_blockers: raising is immutable; only resolution may be written';
  END IF;
  IF OLD.resolved_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_blockers: a resolved blocker is history and cannot change';
  END IF;
  IF NEW.resolved_at IS NULL OR NEW.resolution IS NULL OR NEW.resolved_by_user_id IS NULL THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'work_blockers: resolving requires resolved_at, resolution and resolved_by_user_id together';
  END IF;
END$$

DELIMITER ;
