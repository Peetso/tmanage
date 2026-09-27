-- 0185_decision_comments — an internal threaded comment on a decision (x317 slice).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Requests, decisions & approvals"
-- (decision discussion), 22-SCREEN §"Decision register", 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- A decision on the register (0037) records what a project decided, but it cannot be discussed. This
-- is the smallest useful unit of that discussion: an internal **comment on a decision** — a body of
-- prose, an author, and a time, against an existing decision. Comments are listed oldest-first and a
-- member may delete their own. Editing and reactions are out of this slice.
--
-- ## Decision-owned, and tenant-scoped like every sibling
--
-- `decision_comments.decision_id` is `NOT NULL`: a comment belongs to a decision, the way a
-- supersede edge (0038) or a lock (0056) does. The comment is read and written by the decision's
-- relation (its project), resolved in the service, so the two can never disagree — there is no
-- `project_id` column to drift. The composite foreign key `fk_decision_comments_decision_tenant`
-- binds `(organization_id, decision_id)` to `decisions`, so a comment can only ever name a decision
-- of its own tenant — a cross-tenant decision id does not exist as a pair even when both ids exist
-- individually.
--
-- ## The author is a membership, not a bare user
--
-- `author_membership_id` names the membership row the comment was written under, bound by the
-- composite key `fk_decision_comments_author_tenant` to `(organization_id, id)` of `memberships`: an
-- author is always a member of the comment's own tenant. `body` is `TEXT` and `NOT NULL` — prose a
-- person types, the choice `document_comments.body` (0045) and `work_item_comments.body` (0053) make.
-- Decisions are internal, so a comment is authored by an internal membership and never projected to
-- a client surface.
--
-- ## Append-once, immutable, deletable by its author
--
-- A captured comment is a record of what someone said at a moment: it is never edited in place, so
-- the `BEFORE UPDATE` trigger refuses every UPDATE outright, the posture `document_comments` (0045)
-- and `work_item_comments` (0053) take. It may be removed by its author, so DELETE is granted (see
-- users.sql) where those siblings withhold it — the delete destroys no history the audit trail does
-- not keep. ADR-0001 layers 3 and 4 are application-side and a direct SQL session bypasses both; the
-- trigger holds the no-edit rule at the engine.

CREATE TABLE decision_comments (
  id                   CHAR(36)     NOT NULL,
  organization_id      CHAR(36)     NOT NULL,
  decision_id          CHAR(36)     NOT NULL,
  -- The membership the comment was written under; see the note above.
  author_membership_id CHAR(36)     NOT NULL,
  -- The comment body. Prose a person types, so TEXT and NOT NULL like document_comments.body.
  body                 TEXT         NOT NULL,
  created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_decision_comments_org_id (organization_id, id),
  -- The index a decision's comments are listed by: this tenant's comments for this decision, in
  -- created-at then id (≈ creation) order. Leads with `organization_id` per `07-DATA-MODEL` §9.
  KEY ix_decision_comments_org_decision (organization_id, decision_id, created_at, id),
  CONSTRAINT fk_decision_comments_decision_tenant
    FOREIGN KEY (organization_id, decision_id) REFERENCES decisions (organization_id, id),
  CONSTRAINT fk_decision_comments_author_tenant
    FOREIGN KEY (organization_id, author_membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A captured comment is never edited: the trigger refuses every UPDATE at the engine, the posture
-- document_comments (0045) and work_item_comments (0053) take. Deletion by the author is allowed
-- through the DELETE grant; there is no edit endpoint and no UPDATE grant.
DELIMITER $$

CREATE TRIGGER trg_decision_comments_immutable
BEFORE UPDATE ON decision_comments FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'decision_comments rows are immutable';
END$$

DELIMITER ;
