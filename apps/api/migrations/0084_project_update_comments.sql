-- 0084_project_update_comments — SEC: Portal update comment thread (module 13, x203).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Client portal" (the deferred
-- update *comment* lifecycle 0041 named and left out), 23-ERD-AND-STATE-MACHINES §2 (tenant-scoped,
-- parent-owned records), 07-DATA-MODEL §9 (index prefixes lead with `organization_id`),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §5-6 (composite tenant keys, scoped writes), ADR-0001
-- (MySQL has no row-level security; layers 3-5 replace it).
--
-- ## What this migration is for
--
-- `0041_project_updates.sql` shipped the one-way updates timeline and named, in its own header, the
-- "update edit/unpublish/comment lifecycle" as a later slice. This is the *comment* half at its
-- smallest useful size: an **internally-posted comment on a published update**, which the client
-- reading that update's timeline is then shown. It is the smallest table that lets an agency reply
-- in-thread to its own update rather than posting a whole new one.
--
-- A comment is authored by an internal member behind `project.manage` and read by the client behind
-- `client_projection.read`. A **client** reply needs a client-write capability the permission matrix
-- does not yet grant (12-PERMISSION-MATRIX) — that is Needs-Peter, so this slice is internal-post →
-- client-read only, and there is deliberately no author-audience column: every row here is internal.
--
-- ## Parent- and tenant-scoped
--
-- A comment belongs to one project update of one studio. `organization_id` scopes it to the tenant,
-- the way every sibling table is scoped; the composite foreign key
-- `fk_project_update_comments_update` binds `(organization_id, update_id)` to
-- `project_updates (organization_id, id)`, so a comment can only ever name an update of its own
-- tenant — a cross-tenant `update_id` does not exist as a pair even when both ids exist
-- individually. That is the engine half of the trap the service also enforces in code: the update
-- is resolved inside the named project and tenant first, so a cross-tenant or other-project id is a
-- 404 with no write, and the client read of one update's comments can never surface another
-- project's. The `created_by_user_id` foreign key ties the author to a real user.
--
-- ## Append-only
--
-- A comment is a record of what was said, when. It is inserted and read, never edited or removed:
-- the runtime credential is granted INSERT and nothing else (see `scripts/db/users.sql`), and the
-- `BEFORE UPDATE` trigger refuses any amendment for every other credential besides — the
-- append-only posture `work_item_comments` (0053) and `meeting_notes` (0033) carry. Edit and delete
-- are a later slice that adds the privilege with the code that writes it.

CREATE TABLE project_update_comments (
  id                 CHAR(36)    NOT NULL,
  organization_id    CHAR(36)    NOT NULL,
  -- NOT NULL. A comment belongs to a published update; the composite key below makes a cross-tenant
  -- update_id a non-existent pair rather than a leak.
  update_id          CHAR(36)    NOT NULL,
  -- Free text. TEXT rather than VARCHAR because a comment is prose a person types, not a short
  -- handle (the choice `work_item_comments.body` made).
  body               TEXT        NOT NULL,
  -- The internal member who posted the comment. Every row here is internal-authored (client reply is
  -- Needs-Peter); the client projection drops this field, the way it drops `project_updates`' author.
  created_by_user_id CHAR(36)    NOT NULL,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_project_update_comments_org_id (organization_id, id),
  -- 07-DATA-MODEL §9: the one read that exists — this tenant's comments for one update, in
  -- created-at (then id) order. Leads with `organization_id`.
  KEY ix_project_update_comments_update (organization_id, update_id, created_at, id),
  -- A comment can only ever name an update of its own tenant; the composite key is what makes a
  -- cross-tenant `update_id` a non-existent pair rather than a leak.
  CONSTRAINT fk_project_update_comments_update
    FOREIGN KEY (organization_id, update_id) REFERENCES project_updates (organization_id, id),
  CONSTRAINT fk_project_update_comments_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A comment is append-only: once written it is neither re-parented, re-attributed nor edited. The
-- trigger holds that at the engine — ADR-0001 layers 3 and 4 are application-side and a direct SQL
-- session bypasses both — for the credentials that do hold UPDATE. The runtime credential holds none
-- (users.sql), so this is defence in depth, the `work_item_comments` posture.
DELIMITER $$

CREATE TRIGGER trg_project_update_comments_immutable
BEFORE UPDATE ON project_update_comments FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'project_update_comments rows are append-only';
END$$

DELIMITER ;
