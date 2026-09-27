-- 0086_work_item_files — attach an already-uploaded file to a work item (x205, Work module 7).
--
-- Governing sources: 38-MODULE-MAP §Work management + §Files (the audit's "Work built; Files
-- built; no join between them"), 23-ERD-AND-STATE-MACHINES §2 (tenant-scoped, parent-owned
-- records), 07-DATA-MODEL §9 (index prefixes lead with `organization_id`), 25-AUTHORIZATION-
-- AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- WORK-001 stores the work item; FILE-001 stores the file asset. Both modules exist, but
-- nothing joins them: a work item's detail screen cannot show the files that belong to it.
-- This is that join at its smallest useful size — a link row naming one work item and one
-- already-uploaded file of the same studio and the same project. No bytes move here: the
-- upload flow (FILE-001) already produced the asset; this only records that it is attached.
-- Attach / list / detach, and nothing more.
--
-- ## Parent- and tenant-scoped, on BOTH sides
--
-- A link belongs to one studio. `organization_id` scopes it to the tenant the way every
-- sibling table is scoped. Two composite foreign keys — not one — bind it to its ends within
-- that tenant:
--   · `fk_work_item_files_work_item` binds `(organization_id, work_item_id)` to
--     `work_items (organization_id, id)`;
--   · `fk_work_item_files_file_asset` binds `(organization_id, file_asset_id)` to
--     `file_assets (organization_id, id)`.
-- So a cross-tenant `work_item_id` OR a cross-tenant `file_asset_id` is a non-existent pair
-- even when both ids exist individually — the engine half of the trap the service also
-- enforces in code: a cross-tenant end is a 404, never a write that attaches another studio's
-- file. `attached_by_membership_id` records the studio member who made the link.
--
-- ## Removable, and immutable while it exists
--
-- A link is added (INSERT) and removed (DELETE) — detach is a real operation and its removal
-- is audited — but it is never edited: re-parenting a link to a different work item or file is
-- delete-and-add, not UPDATE. The runtime credential is granted INSERT and DELETE and no
-- UPDATE (see `scripts/db/users.sql`), and the `BEFORE UPDATE` trigger refuses any amendment
-- for every other credential besides — the defence-in-depth posture `work_item_dependencies`
-- (0011) carries. The unique key `uq_work_item_files_edge` makes a file attachable to one work
-- item at most once.

CREATE TABLE work_item_files (
  id                        CHAR(36)    NOT NULL,
  organization_id           CHAR(36)    NOT NULL,
  work_item_id              CHAR(36)    NOT NULL,
  file_asset_id             CHAR(36)    NOT NULL,
  -- The membership of the studio that attached the file; `membership_id`, never a raw user id,
  -- so it is scoped to this tenant's directory the way every other actor reference is at rest.
  attached_by_membership_id CHAR(36)    NOT NULL,
  created_at                DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_work_item_files_org_id (organization_id, id),
  -- A file is attached to a work item at most once. Leads with `organization_id` per §9.
  UNIQUE KEY uq_work_item_files_edge (organization_id, work_item_id, file_asset_id),
  -- The index the panel's list is served by: this tenant's attachments for one work item, in
  -- created-at (then id) order.
  KEY ix_work_item_files_item (organization_id, work_item_id, created_at, id),
  -- A link can only ever name a work item of its own tenant; the composite key makes a
  -- cross-tenant `work_item_id` a non-existent pair rather than a leak.
  CONSTRAINT fk_work_item_files_work_item
    FOREIGN KEY (organization_id, work_item_id) REFERENCES work_items (organization_id, id),
  -- ...and a file asset of its own tenant, for the same reason.
  CONSTRAINT fk_work_item_files_file_asset
    FOREIGN KEY (organization_id, file_asset_id) REFERENCES file_assets (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A link is immutable while it exists: it is added and removed, never re-parented or
-- re-attributed. The trigger holds that at the engine — ADR-0001 layers 3 and 4 are
-- application-side and a direct SQL session bypasses both — for the credentials that do hold
-- UPDATE. The runtime credential holds none (users.sql), so this is defence in depth, the
-- `work_item_dependencies` posture.
DELIMITER $$

CREATE TRIGGER trg_work_item_files_immutable
BEFORE UPDATE ON work_item_files FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'work_item_files rows are immutable; detach is DELETE, not UPDATE';
END$$

DELIMITER ;
