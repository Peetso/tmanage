-- 0035_saved_context — HOME-05 saved/pinned context (x110).
--
-- Governing sources: 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX.md §Home HOME-05 ("Saved/pinned
-- context: messages, docs, work, files grouped by project"), 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION-SPEC.md §5-6 (scoped writes, composite (organization_id, id) foreign keys),
-- 07-DATA-MODEL.md §9 (every composite index begins with organization_id), ADR-0001 (MySQL has
-- no row-level security; layers 3-5 replace it).
--
-- ## Migration numbering
--
-- Numbered 0035 as reserved by pass16-queue.txt (0034 x107, 0035 x110). The highest migration on
-- this slice's base (x102, HEAD 2bea6f4) is 0027; 0028-0034 land on master from parallel branches.
-- The number is a set member, not a position (migrator.db.test treats gaps as legitimate), so the
-- integrator renumbers this file only if a collision appears after the parallel merges.
--
-- ## What this stores, and what it deliberately does not
--
-- One row per pin: a per-user, per-tenant *reference* to an entity the user chose to keep at hand
-- on their Home. It stores the reference (entity_type + entity_id) and the project it belongs to,
-- never a copy of the entity's content or title — resolving each pin to a live title/preview needs
-- a per-module read fan-out and is the deferred follow-up (NEXT-SCOPES-9). The reads that render it
-- group by project.
--
-- entity_id carries NO foreign key, deliberately, for the reason file_assets.object_id (0016)
-- carries none: the table it points at depends on entity_type (messages, deliverable_versions,
-- work_items, file_assets), so a single FK cannot express it. Tenant safety does not rest on an FK
-- here: the service resolves entity_id (and project_id) tenant-scoped BEFORE the write, so a
-- missing or cross-tenant id is a 404 with no row written, never a stored dangling reference.
--
-- ## Pins are per user, and are created and removed, never edited
--
-- A pin belongs to exactly one user (user_id) in one tenant, and the only writes are INSERT (pin)
-- and DELETE (unpin). There is no UPDATE path in the repository, no UPDATE grant in scripts/db/
-- users.sql, and so no immutability trigger is needed — the withheld privilege is the control.
-- uq_saved_context_pin makes a re-pin idempotent at the engine: the same (user, entity) collides
-- rather than duplicating.

CREATE TABLE saved_context (
  id                CHAR(36)                              NOT NULL,
  organization_id   CHAR(36)                              NOT NULL,
  -- The user whose saved set this row belongs to. A pin is private to them: the reads and the
  -- unpin are all scoped by user_id = the acting principal, so one user never sees or removes
  -- another's pins even inside the same tenant.
  user_id           CHAR(36)                              NOT NULL,
  -- Which kind of entity the reference points at. An ENUM rather than a free string so a typo is
  -- a write error, and so the four kinds HOME-05 names are the only ones storable.
  entity_type       ENUM('message','doc','work','file')  NOT NULL,
  -- The referenced entity. No FK (see the header): the target table depends on entity_type.
  entity_id         CHAR(36)                              NOT NULL,
  -- The project this pin is grouped under. NULL-able for a future org-level pin; this slice always
  -- sets it, resolved tenant-scoped and bound to the referenced entity's own project. The composite
  -- FK below makes a cross-tenant project reference structurally impossible (MATCH SIMPLE skips the
  -- check only when project_id is NULL, which is the intended org-level case).
  project_id        CHAR(36)                              NULL,
  created_at        DATETIME(3)                           NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The composite key every tenant-owned table carries, the target of the composite FKs that bind
  -- child rows within one tenant.
  UNIQUE KEY uq_saved_context_org_id (organization_id, id),
  -- Idempotent pin: the same user pinning the same entity twice collides here rather than creating
  -- a second row. entity_type is part of the key so two kinds can never share an id space by
  -- accident.
  UNIQUE KEY uq_saved_context_pin (organization_id, user_id, entity_type, entity_id),
  -- 07-DATA-MODEL §9: the one read that exists — a user's pins, grouped by project, newest first.
  KEY ix_saved_context_org_user_project (organization_id, user_id, project_id, created_at),
  CONSTRAINT fk_saved_context_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_saved_context_user
    FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
