-- 0048_project_milestones — SEC: Portal milestones (module 13) — internal write, client read
-- projection (x139 slice 1).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Client portal" ("updates,
-- milestones, risks"), 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX (CLIENT / milestone timeline),
-- 12-PERMISSION-MATRIX §4 (the client projection: "public/client title, summary, milestone
-- state, committed/forecast date …" — milestone state is named, staff is excluded), 23-ERD §2
-- (`PROJECT ||--o{ …` project-owned records), 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §5-7 (composite tenant keys, scoped
-- writes, the client view is a projection not a filtered internal row), ADR-0001 (MySQL has no
-- row-level security; layers 3-5 replace it).
--
-- ## Migration numbering
--
-- Numbered 0048 as reserved by pass20-queue.txt (0042 x126 … 0047 x138, then 0048 x139). The
-- number is a set member, not a position (migrator.db.test treats gaps as legitimate), so the
-- integrator renumbers this file only if a collision appears after the parallel merges.
--
-- ## What this migration is for
--
-- The portal audit is "Portal Partial; milestones deferred": `ClientOverviewScreen` /
-- `ProjectOverviewScreen` carry a `BackendPending` for "milestones", and nothing in the schema
-- can hold one. This is the smallest useful unit that closes the *milestones* half, exactly as
-- `project_updates` (0041) closed the *updates* half and reusing its mechanism: a **project
-- milestone** — a title, a target date, a state, and whether it is published — as a durable,
-- tenant-scoped, project-owned record. Only a published milestone is ever client-visible; the
-- client read filters `published = 1` at the query, the way 0031's client projection serves
-- published-only content. Risks (x140), the portal people page (x142) and any milestone
-- edit/unpublish lifecycle are deliberately out — each is a later slice with its own table and
-- state (NEXT-SCOPES-13).
--
-- ## Project-owned, and tenant-scoped like every sibling
--
-- `project_milestones.project_id` is `NOT NULL`: a milestone belongs to a project, the way an
-- update (0041) and a document (0030) do. The composite foreign key
-- `fk_project_milestones_project_tenant` binds `(organization_id, project_id)` to `projects`, so
-- a milestone can only ever name a project of its own tenant — a cross-tenant project id does not
-- exist as a pair even when both ids exist individually, and a client can therefore never be
-- shown, and an internal author can never write, a milestone against another studio's project.
--
-- ## `published` is the client-visibility gate
--
-- A boolean, `NOT NULL DEFAULT 0`. Intent is not exposure: a milestone exists as soon as it is
-- created, but it reaches a client only once `published = 1`. The client read predicate is
-- `published = 1`; a publish/unpublish lifecycle can land later (NEXT-SCOPES-13) without a schema
-- change, and this slice simply sets the flag at insert time.
--
-- ## `status` is the milestone state §4 names
--
-- An enum `planned | met | missed`, `NOT NULL DEFAULT 'planned'`. It is "milestone state" from
-- 12-PERMISSION-MATRIX §4 — a client-safe fact about the deliverable, not the internal work
-- lifecycle. `due_on` is a DATE (a target day, not an instant), like `projects.committed_at`.
--
-- ## Identity is immutable
--
-- `organization_id`, `project_id` and `created_by_user_id` are what a milestone *is*: re-pointing
-- a milestone at another project would move it, silently, into a portal a different client can
-- read. The `BEFORE UPDATE` trigger holds that at the engine — the reason every other trigger in
-- this schema exists, ADR-0001 layers 3 and 4 being application-side and bypassed by a direct SQL
-- session. `title`, `due_on`, `status` and `published` stay editable for the later lifecycle.

CREATE TABLE project_milestones (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- NOT NULL. A milestone belongs to a project; see the note above.
  project_id         CHAR(36)     NOT NULL,
  -- `documents.title` / `project_updates.title` are VARCHAR(300); a milestone headline is the
  -- same kind of short handle.
  title              VARCHAR(300) NOT NULL,
  -- The target day. A DATE, not a DATETIME: a milestone is a day a deliverable is due, the same
  -- kind of value `projects.committed_at` holds. Nullable — a milestone can be named before its
  -- date is committed.
  due_on             DATE         NULL,
  -- The milestone state §4 names. A client-safe fact, not the internal work lifecycle.
  status             ENUM('planned', 'met', 'missed') NOT NULL DEFAULT 'planned',
  -- The client-visibility gate. A client read selects `published = 1` only; an unpublished
  -- milestone is invisible to every external principal.
  published          BOOLEAN      NOT NULL DEFAULT 0,
  created_by_user_id CHAR(36)     NOT NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_project_milestones_org_id (organization_id, id),
  -- 07-DATA-MODEL §9: the one read that exists — this tenant's milestones for this project,
  -- ordered by target date. Leads with `organization_id`.
  KEY ix_project_milestones_org_project (organization_id, project_id, due_on),
  CONSTRAINT fk_project_milestones_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_project_milestones_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A milestone's tenant, project and author are immutable, for the reason `project_updates`'
-- trigger gives: re-pointing a milestone at another project would move it into a portal a
-- different client can read, silently. `title`, `due_on`, `status` and `published` are editable
-- (the lifecycle is a later slice); identity is not.
DELIMITER $$

CREATE TRIGGER trg_project_milestones_immutable
BEFORE UPDATE ON project_milestones FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_milestones.organization_id is immutable';
  END IF;
  IF NEW.project_id <> OLD.project_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_milestones.project_id is immutable';
  END IF;
  IF NEW.created_by_user_id <> OLD.created_by_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_milestones.created_by_user_id is immutable';
  END IF;
END$$

DELIMITER ;
