-- 0034_saved_views — the first durable Work-views record (WK-08, x107 slice).
--
-- Governing sources: 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §Work WK-08 (Saved view editor:
-- filters, grouping, columns, sharing), 38-…MODULE-MAP §Work management, 23-ERD-AND-STATE-MACHINES
-- §2 (tenant- and, here, user-owned records), 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## What this migration is for
--
-- WK-04 Timeline (x94), WK-05 Calendar and WK-06 Workload are read-only *views* that compose
-- rows already stored. Saved views is the first Work view a person **writes**: a named,
-- reusable filter/grouping/columns configuration over the existing list and board reads, kept
-- so a colleague does not rebuild it by hand each morning. This is the smallest useful unit —
-- persist / list / apply — and nothing more of the doc-38 vision (no column-level sharing ACLs,
-- no cross-user share governance beyond own-org + a private/shared flag; those are NEXT-SCOPES-9).
--
-- ## Owner- and tenant-scoped; the project reference is optional
--
-- Unlike a meeting or a document, a saved view belongs to a **person** as well as a studio:
-- `owner_user_id` is NOT NULL and is who may edit it. `organization_id` scopes it to the studio,
-- the way every sibling table is scoped. `project_id` is **NULL-able**: a view can be scoped to
-- one project or be an org-wide view of all work the caller may read. The composite foreign key
-- `fk_saved_views_project_tenant` binds `(organization_id, project_id)` to `projects`, so a
-- project-scoped view can only ever name a project of its own tenant — a cross-tenant project id
-- does not exist as a pair even when both ids exist individually. MySQL's default MATCH SIMPLE
-- means a row with a NULL `project_id` skips that check, which is exactly what an org-wide view
-- wants: no project to reference, so nothing to enforce.
--
-- ## `config` is JSON, echoed not re-implemented
--
-- `config` holds the filter/grouping/columns the view remembers, as JSON. The apply step echoes
-- it back for the client to drive the *existing* list/board reads; this slice adds no
-- server-side filtering beyond what WORK-001/WORK-003 already expose. It is `NOT NULL` because a
-- view with no configuration is not a view.
--
-- ## `shared` is a single flag this slice
--
-- `shared` NOT NULL DEFAULT 0: a private view is visible to its owner only; a shared view is
-- visible to every member of the owning studio. Column-level sharing ACLs and cross-org sharing
-- are deliberately out of scope (NEXT-SCOPES-9) — a flag, not an ACL table with nothing to
-- reference yet, the mistake `0007_conversations.sql` refused with its absent `kind` column.
--
-- ## Identity is immutable
--
-- `organization_id` and `owner_user_id` are what a saved view *is*: re-owning a view or moving
-- it to another studio is not an edit. The `BEFORE UPDATE` trigger holds that at the engine,
-- the reason every other trigger in this schema exists — ADR-0001 layers 3 and 4 are
-- application-side and a direct SQL session bypasses both. `name`, `project_id`, `config` and
-- `shared` are editable; identity is not.

CREATE TABLE saved_views (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- NOT NULL. A saved view belongs to the person who created it; see the note above.
  owner_user_id      CHAR(36)     NOT NULL,
  -- NULL-able. A project-scoped view names one project; an org-wide view names none.
  project_id         CHAR(36)     NULL,
  -- `client_requests.title` is VARCHAR(300); a view name is the same kind of short handle.
  name               VARCHAR(300) NOT NULL,
  -- The filter/grouping/columns configuration, echoed to the client to drive existing reads.
  config             JSON         NOT NULL,
  -- 0 = private to the owner, 1 = visible to every member of the owning studio.
  shared             TINYINT(1)   NOT NULL DEFAULT 0,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_saved_views_org_id (organization_id, id),
  -- The index a person's own views are listed by: this tenant's views owned by this user, in
  -- id (≈ creation) order. Leads with `organization_id` per `07-DATA-MODEL` §9.
  KEY ix_saved_views_org_owner (organization_id, owner_user_id, id),
  -- The index the shared-in-org half of the list is served by.
  KEY ix_saved_views_org_shared (organization_id, shared, id),
  -- A project-scoped view can only ever name a project of its own tenant; a NULL project_id
  -- (org-wide view) skips the check under MATCH SIMPLE.
  CONSTRAINT fk_saved_views_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_saved_views_owner
    FOREIGN KEY (owner_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A saved view's tenant and owner are immutable, for the reason `conversations`' trigger gives:
-- re-owning a view or moving it to another studio would change what it is, silently. Editing is
-- a change to `name`, `project_id`, `config` and `shared` and to nothing else.
DELIMITER $$

CREATE TRIGGER trg_saved_views_immutable
BEFORE UPDATE ON saved_views FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'saved_views.organization_id is immutable';
  END IF;
  IF NEW.owner_user_id <> OLD.owner_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'saved_views.owner_user_id is immutable';
  END IF;
END$$

DELIMITER ;
