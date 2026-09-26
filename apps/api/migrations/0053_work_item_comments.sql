-- 0053_work_item_comments — a work item's comments / activity (x147, Work module 7).
--
-- Governing sources: 38-MODULE-MAP §Work (activity/comments — the audit's "Work Partial:
-- comments not built"), 23-ERD-AND-STATE-MACHINES §2 (tenant-scoped, parent-owned records),
-- 07-DATA-MODEL §9 (index prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- WORK-001 stores the work item; its detail screen (TM-13) names an "activity / discussion"
-- section that is its own object and was not yet built. This is that object at its smallest
-- useful size: an append-only, time-ordered list of internal comments hanging off one work
-- item. These are distinct from the channel-scoped conversation `messages` (0007) — a comment
-- is about *this work item*, authored by a membership of the studio, and never client-visible.
-- Add / list, and nothing more — edit, delete, mentions and reactions are deferred to NS-13,
-- the mistake 0007 refused when it left out a column with nothing to reference yet.
--
-- ## Parent- and tenant-scoped
--
-- A comment belongs to one work item of one studio. `organization_id` scopes it to the tenant,
-- the way every sibling table is scoped; the composite foreign key
-- `fk_work_item_comments_work_item` binds `(organization_id, work_item_id)` to
-- `work_items (organization_id, id)`, so a comment can only ever name a work item of its own
-- tenant — a cross-tenant `work_item_id` does not exist as a pair even when both ids exist
-- individually. That is the engine half of the trap the service also enforces in code: a
-- cross-tenant parent is a 404, never a write.
--
-- ## Append-only
--
-- A comment is a record of what was said, when. It is inserted and read, never edited or
-- removed: the runtime credential is granted INSERT and nothing else (see `scripts/db/users.sql`),
-- and the `BEFORE UPDATE` trigger refuses any amendment for every other credential besides —
-- the append-only posture `meeting_notes` (0033) and `document_versions` (0036) carry. Edit and
-- delete are a later slice that adds the privilege with the code that writes it.

CREATE TABLE work_item_comments (
  id                    CHAR(36)    NOT NULL,
  organization_id       CHAR(36)    NOT NULL,
  work_item_id          CHAR(36)    NOT NULL,
  -- The membership of the studio that authored the comment; `membership_id`, never a raw user id,
  -- so it is scoped to this tenant's directory the way every other actor reference is at rest.
  author_membership_id  CHAR(36)    NOT NULL,
  -- Free text. TEXT rather than VARCHAR because a comment is prose, not a short handle.
  body                  TEXT        NOT NULL,
  created_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_work_item_comments_org_id (organization_id, id),
  -- The index the panel's list is served by: this tenant's comments for one work item, in
  -- created-at (then id) order. Leads with `organization_id` per `07-DATA-MODEL` §9.
  KEY ix_work_item_comments_item (organization_id, work_item_id, created_at, id),
  -- A comment can only ever name a work item of its own tenant; the composite key is what makes
  -- a cross-tenant `work_item_id` a non-existent pair rather than a leak.
  CONSTRAINT fk_work_item_comments_work_item
    FOREIGN KEY (organization_id, work_item_id) REFERENCES work_items (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A comment is append-only: once written it is neither re-parented, re-attributed nor edited.
-- The trigger holds that at the engine — ADR-0001 layers 3 and 4 are application-side and a
-- direct SQL session bypasses both — for the credentials that do hold UPDATE. The runtime
-- credential holds none (users.sql), so this is defence in depth, the `meeting_notes` posture.
DELIMITER $$

CREATE TRIGGER trg_work_item_comments_immutable
BEFORE UPDATE ON work_item_comments FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'work_item_comments rows are append-only';
END$$

DELIMITER ;
