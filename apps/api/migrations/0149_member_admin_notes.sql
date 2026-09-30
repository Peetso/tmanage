-- 0149_member_admin_notes — SEC: Admin private member notes (module 18 Administration, x280).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Administration (the member-admin
-- annotation surface named and left out), 22-SCREEN-INVENTORY §Administration (member detail),
-- 23-ERD-AND-STATE-MACHINES §2 (tenant-scoped, parent-owned records), 07-DATA-MODEL §9 (index
-- prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §5-6 (composite
-- tenant keys, scoped writes), ADR-0001 (MySQL has no row-level security; layers 3-5 replace it).
--
-- ## What this migration is for
--
-- An org admin's private, internal notes about a member — an HR-style annotation attached to a
-- membership, added and removed by `org.manage` holders and **never** surfaced on any member-facing
-- read path. This is the smallest table that lets an administrator record "spoke to X about Y" on a
-- member without that note ever being shown to the member it is about.
--
-- ## Parent- and tenant-scoped
--
-- A note belongs to one membership of one studio. `organization_id` scopes it to the tenant, the way
-- every sibling table is scoped; the composite foreign key `fk_member_admin_notes_subject` binds
-- `(organization_id, subject_membership_id)` to `memberships (organization_id, id)`, so a note can
-- only ever name a membership of its own tenant — a cross-tenant `subject_membership_id` does not
-- exist as a pair even when both ids exist individually. That is the engine half of the trap the
-- service also enforces in code: the subject membership is resolved inside the tenant first, so a
-- cross-tenant or unknown id is a 404 with no write. `fk_member_admin_notes_author` binds the author
-- to the acting membership of the same tenant.
--
-- ## Append-only
--
-- A note is a record of what was written, by whom, when. It is inserted, read and deleted, never
-- edited: the runtime credential is granted INSERT and DELETE and nothing else (see
-- `scripts/db/users.sql`), and the `BEFORE UPDATE` trigger refuses any amendment for every other
-- credential besides — the append-only posture `work_item_comments` (0053), `meeting_notes` (0033)
-- and `project_update_comments` (0084) carry. There is no `UPDATE` privilege and no edit endpoint:
-- a note's body and attribution are fixed once written; correcting one is delete-and-re-add.

CREATE TABLE member_admin_notes (
  id                    CHAR(36)    NOT NULL,
  organization_id       CHAR(36)    NOT NULL,
  -- The member the note is about. The composite key below makes a cross-tenant membership id a
  -- non-existent pair rather than a leak.
  subject_membership_id CHAR(36)    NOT NULL,
  -- Free text. TEXT rather than VARCHAR because a note is prose a person types, not a short handle
  -- (the choice `work_item_comments.body` and `project_update_comments.body` made).
  body                  TEXT        NOT NULL,
  -- The internal member (an `org.manage` holder) who wrote the note — the acting membership, never a
  -- value from the request body. Bound to the tenant by the composite key below.
  author_membership_id  CHAR(36)    NOT NULL,
  created_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so the guard can scope reads
  -- and writes and a future child could reference this row without a cross-tenant path.
  UNIQUE KEY uq_member_admin_notes_org_id (organization_id, id),
  -- 07-DATA-MODEL §9: the one read that exists — this tenant's notes for one member, newest first.
  -- Leads with `organization_id`.
  KEY ix_member_admin_notes_subject (organization_id, subject_membership_id, id),
  -- A note can only ever name a membership of its own tenant; the composite key is what makes a
  -- cross-tenant `subject_membership_id` a non-existent pair rather than a leak.
  CONSTRAINT fk_member_admin_notes_subject
    FOREIGN KEY (organization_id, subject_membership_id) REFERENCES memberships (organization_id, id),
  CONSTRAINT fk_member_admin_notes_author
    FOREIGN KEY (organization_id, author_membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A note is append-only: once written it is neither re-parented, re-attributed nor edited. The
-- trigger holds that at the engine — ADR-0001 layers 3 and 4 are application-side and a direct SQL
-- session bypasses both — for the credentials that do hold UPDATE. The runtime credential holds none
-- (users.sql), so this is defence in depth, the `project_update_comments` posture.
DELIMITER $$

CREATE TRIGGER trg_member_admin_notes_immutable
BEFORE UPDATE ON member_admin_notes FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'member_admin_notes rows are append-only';
END$$

DELIMITER ;
