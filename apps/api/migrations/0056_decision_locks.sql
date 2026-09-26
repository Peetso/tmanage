-- 0056_decision_locks — SEC: Decisions (module 12) — the decision-lock write boundary (x150).
--
-- Migration number: 0056, as reserved by pass20-queue.txt (highest applied after pass 19 is 0041;
-- pass 20 reserves 0042…0059, and x150 draws 0056). The migrator applies files in ascending numeric
-- order and a gap is not an error (it rejects only a NEW file numbered *below* an applied one), so
-- 0056 on top of the pass-20 set is correct. The number is a set member, not a position
-- (migrator.db.test treats gaps as legitimate); the integrator renumbers this file only if a
-- collision appears after the parallel merges.
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Decisions ("lock a decided record");
-- 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §Decisions (DEC — the register's decided record); 23-ERD §2
-- (`PROJECT ||--o{ …` project-owned records, reached here through the decision it locks); 07-DATA-MODEL
-- §9 (index prefixes lead with `organization_id`); 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite
-- tenant keys, scoped writes); ADR-0001 (MySQL has no row-level security; the engine trigger is the
-- layer a direct SQL session cannot bypass).
--
-- ## What this migration is for
--
-- The Decisions audit is "Partial; decision lock deferred". 0037 shipped the register (a decision is
-- authored and read) and 0038 the lifecycle (accept / supersede, its trigger relaxed to pin every
-- column but `status`). Nothing yet makes a decided record *immutable on demand*: a decision can still
-- be moved through its lifecycle after the project considers it settled. This is the smallest useful
-- unit that closes that gap — a **decision lock**: an append-only record that a decision has been
-- locked, by whom and when. Once a lock exists for a decision, every mutating decision route refuses a
-- write to it (409, no write), enforced in `decisions.service`; the lock row is that refusal's durable
-- record. Re-locking a locked decision is a no-op conflict (409) and writes no second row. An unlock
-- workflow needs approval and is deliberately out (NEXT-SCOPES-13).
--
-- ## The lock is its own table, tenant-scoped, one-per-decision
--
-- A lock is a fact about a decision, recorded once, so it is a row of its own rather than a column on
-- `decisions` — the same judgement `decision_supersessions` (0038) made for the supersede edge, and it
-- keeps the 0038 column-pinning trigger on `decisions` untouched (no new editable column to pin).
--
-- `fk_decision_locks_decision_tenant` binds `(organization_id, decision_id)` to
-- `decisions (organization_id, id)`, so a lock can only ever name a decision of its own tenant — a
-- cross-tenant `decision_id` does not exist as a pair even when both ids exist individually, and a
-- caller can therefore never lock, or be shown a lock on, another studio's decision at the engine.
-- `uq_decision_locks_org_decision` makes a decision lockable at most once: a second lock naming the
-- same `decision_id` is refused by the unique key, which is the engine-level backstop beneath the
-- service's own re-lock check (a re-lock is a 409 with no second row).
--
-- ## The row is immutable
--
-- A lock, once written, is the register's record that a decision was sealed: who locked it and when.
-- The `BEFORE UPDATE` trigger refuses every UPDATE at the engine — the reason `decision_supersessions`
-- (0038) and the append-only ledgers carry the same trigger: ADR-0001 layers 3 and 4 are
-- application-side and a direct SQL session bypasses them. `users.sql` grants the runtime credential
-- INSERT only (no UPDATE, no DELETE), so "a lock cannot be amended or lifted" holds for the runtime
-- credential specifically, and the engine trigger holds it for every credential.

CREATE TABLE decision_locks (
  id               CHAR(36)    NOT NULL,
  organization_id  CHAR(36)    NOT NULL,
  -- The decision this lock seals. Its lifecycle writes are refused while this row exists.
  decision_id      CHAR(36)    NOT NULL,
  -- The person who locked the decision — the service passes `context.userId`.
  locked_by        CHAR(36)    NOT NULL,
  locked_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_decision_locks_org_id (organization_id, id),
  -- A decision is locked at most once; the re-lock conflict has one recorded cause.
  UNIQUE KEY uq_decision_locks_org_decision (organization_id, decision_id),
  CONSTRAINT fk_decision_locks_decision_tenant
    FOREIGN KEY (organization_id, decision_id) REFERENCES decisions (organization_id, id),
  CONSTRAINT fk_decision_locks_locked_by
    FOREIGN KEY (locked_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A lock, once recorded, is immutable: it is the register's record that a decision was sealed. The
-- trigger refuses every UPDATE at the engine, the reason `decision_supersessions` (0038) carries it —
-- a direct SQL session bypasses the application layers.
DELIMITER $$

CREATE TRIGGER trg_decision_locks_immutable
BEFORE UPDATE ON decision_locks FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'decision_locks rows are immutable';
END$$

DELIMITER ;
