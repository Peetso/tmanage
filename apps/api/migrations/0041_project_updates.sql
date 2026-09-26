-- 0041_project_updates — CLIENT-003 project updates timeline (x125 slice 1).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Client portal" ("updates,
-- milestones, risks"), 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX CLIENT-003 (portal timeline / updates),
-- 23-ERD-AND-STATE-MACHINES §2 (`PROJECT ||--o{ …` project-owned records), 07-DATA-MODEL §9 (index
-- prefixes lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §5-6 (composite
-- tenant keys, scoped writes), ADR-0001 (MySQL has no row-level security; layers 3-5 replace it).
--
-- ## Migration numbering
--
-- Numbered 0041 as reserved by pass19-queue.txt (0040 x124 project_objectives, then 0041 x125). The
-- highest migration on this slice's base (08f55d0, pass 16) is 0035; 0036-0040 land on master from
-- parallel branches. The number is a set member, not a position (migrator.db.test treats gaps as
-- legitimate), so the integrator renumbers this file only if a collision appears after the parallel
-- merges.
--
-- ## What this migration is for
--
-- `ClientOverviewScreen.tsx` renders an explicit `BackendPending` for "updates, milestones and
-- risks" and nothing in the schema can hold a project update. This is the smallest useful unit that
-- changes that for the *updates* half: a **project update** — a title, a body, and whether it is
-- published — as a durable, tenant-scoped, project-owned record. Only a published update is ever
-- client-visible; the client read filters `published = 1` at the query, the way x97's client
-- projection serves published-only content. Milestones, risks, the portal people page and any
-- update edit/unpublish/comment lifecycle are deliberately out — each is a later slice with its own
-- table and state (NEXT-SCOPES-12). Adding a `milestone_id` or a `risk_id` here, before those tables
-- exist, would be a foreign key with nothing to reference, the mistake 0030 refused.
--
-- ## Project-owned, and tenant-scoped like every sibling
--
-- `project_updates.project_id` is `NOT NULL`: an update belongs to a project, the way a document
-- (0030) and a meeting (0029) do. The composite foreign key `fk_project_updates_project_tenant`
-- binds `(organization_id, project_id)` to `projects`, so an update can only ever name a project of
-- its own tenant — a cross-tenant project id does not exist as a pair even when both ids exist
-- individually, and a client can therefore never be shown, and an internal poster can never write,
-- an update against another studio's project.
--
-- ## `published` is the client-visibility gate
--
-- A boolean, `NOT NULL DEFAULT 0`. Intent is not exposure: an update exists as soon as it is posted,
-- but it reaches a client only once `published = 1`. The client read predicate is `published = 1`,
-- and the immutability trigger below leaves `title`, `body` and `published` editable while pinning
-- identity — so a publish/unpublish lifecycle can land later (NEXT-SCOPES-12) without a schema
-- change, and this slice simply sets the flag at insert time.
--
-- ## Identity is immutable
--
-- `organization_id`, `project_id` and `created_by_user_id` are what an update *is*: re-pointing an
-- update at another project would move it, silently, into a portal a different client can read. The
-- `BEFORE UPDATE` trigger holds that at the engine — the reason every other trigger in this schema
-- exists, ADR-0001 layers 3 and 4 being application-side and bypassed by a direct SQL session.

CREATE TABLE project_updates (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- NOT NULL. An update belongs to a project; see the note above.
  project_id         CHAR(36)     NOT NULL,
  -- `documents.title` is VARCHAR(300); a project update headline is the same kind of short handle.
  title              VARCHAR(300) NOT NULL,
  -- The update body. Plain text this slice, and TEXT rather than VARCHAR because it is prose a
  -- person types rather than a form field with a column-width rule (the choice `documents.body`
  -- made). Rich text and history are later.
  body               TEXT         NOT NULL,
  -- The client-visibility gate. A client read selects `published = 1` only; an unpublished update
  -- is invisible to every external principal.
  published          BOOLEAN      NOT NULL DEFAULT 0,
  created_by_user_id CHAR(36)     NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child (an
  -- update's comments) can reference this row without a cross-tenant path.
  UNIQUE KEY uq_project_updates_org_id (organization_id, id),
  -- 07-DATA-MODEL §9: the one read that exists — this tenant's published updates for this project,
  -- newest first. Leads with `organization_id`; `created_at DESC` matches the client timeline order.
  KEY ix_project_updates_org_project (organization_id, project_id, created_at),
  CONSTRAINT fk_project_updates_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_project_updates_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An update's tenant, project and author are immutable, for the reason `documents`' trigger gives:
-- re-pointing an update at another project would move it into a portal a different client can read,
-- silently. `title`, `body` and `published` are editable (the publish lifecycle is a later slice);
-- identity is not.
DELIMITER $$

CREATE TRIGGER trg_project_updates_immutable
BEFORE UPDATE ON project_updates FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_updates.organization_id is immutable';
  END IF;
  IF NEW.project_id <> OLD.project_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_updates.project_id is immutable';
  END IF;
  IF NEW.created_by_user_id <> OLD.created_by_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_updates.created_by_user_id is immutable';
  END IF;
END$$

DELIMITER ;
