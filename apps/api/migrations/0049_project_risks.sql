-- 0049_project_risks — SEC: Portal risks (module 13) — internal write, client read projection
-- (x140 slice).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Client portal" ("updates,
-- milestones, risks"), 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX (CLIENT / risks), 12-PERMISSION-MATRIX
-- §4 (the client projection: "public/client title, summary, milestone state, committed/forecast
-- date, published risk …" — the *published risk* summary is named, staff and internal notes are
-- excluded), 23-ERD §2 (`PROJECT ||--o{ …` project-owned records), 07-DATA-MODEL §9 (index prefixes
-- lead with `organization_id`), 25-AUTHORIZATION-AND-TENANT-ISOLATION §5-7 (composite tenant keys,
-- scoped writes, the client view is a projection not a filtered internal row), ADR-0001 (MySQL has
-- no row-level security; layers 3-5 replace it).
--
-- ## Migration numbering
--
-- Numbered 0049 as reserved by pass20-queue.txt (0048 x139, then 0049 x140). The number is a set
-- member, not a position (migrator.db.test treats gaps as legitimate), so the integrator renumbers
-- this file only if a collision appears after the parallel merges.
--
-- ## What this migration is for
--
-- The portal audit is "Portal Partial; risks deferred": `ClientOverviewScreen` carries a
-- `BackendPending` for "risks — unscheduled", and nothing in the schema can hold one. This is the
-- smallest useful unit that closes the *risks* half, exactly as `project_updates` (0041) closed
-- updates and `project_milestones` (0048) closed milestones, reusing their mechanism: a **project
-- risk** — an internal title, a severity, a status, an internal note, a client-facing summary, and
-- whether it is published — as a durable, tenant-scoped, project-owned record. Only a published risk
-- is ever client-visible; the client read filters `published = 1` at the query, the way 0031's client
-- projection serves published-only content. Any risk edit/unpublish or mitigation-owner lifecycle is
-- deliberately out — a later slice with its own state (NEXT-SCOPES-13).
--
-- ## Project-owned, and tenant-scoped like every sibling
--
-- `project_risks.project_id` is `NOT NULL`: a risk belongs to a project, the way an update (0041), a
-- milestone (0048) and a document (0030) do. The composite foreign key `fk_project_risks_project_tenant`
-- binds `(organization_id, project_id)` to `projects`, so a risk can only ever name a project of its
-- own tenant — a cross-tenant project id does not exist as a pair even when both ids exist
-- individually, and a client can therefore never be shown, and an internal author can never write, a
-- risk against another studio's project.
--
-- ## The audience boundary is the substance
--
-- `internal_note` is the internal-only detail — the reason behind the risk, never projected to a
-- client. `client_summary` is the client-facing description, the one text a client is ever shown.
-- `title` is an internal handle. `severity` and `status` are client-safe facts. The client read
-- returns `client_summary`, `severity` and `status` only; `internal_note`, `title`,
-- `created_by_user_id` and `published` never cross to a client.
--
-- ## `published` is the client-visibility gate
--
-- A boolean, `NOT NULL DEFAULT 0`. A risk exists as soon as it is recorded, but it reaches a client
-- only once `published = 1`. The client read predicate is `published = 1`; a publish/unpublish
-- lifecycle can land later (NEXT-SCOPES-13) without a schema change, and this slice sets the flag at
-- insert time.
--
-- ## `severity` and `status` are enums
--
-- `severity` is `low | medium | high`, `NOT NULL DEFAULT 'medium'`. `status` is
-- `open | mitigated | closed`, `NOT NULL DEFAULT 'open'` — a risk is open when first recorded.
--
-- ## Identity is immutable
--
-- `organization_id`, `project_id` and `created_by_user_id` are what a risk *is*: re-pointing a risk
-- at another project would move it, silently, into a portal a different client can read. The
-- `BEFORE UPDATE` trigger holds that at the engine — the reason every other trigger in this schema
-- exists, ADR-0001 layers 3 and 4 being application-side and bypassed by a direct SQL session.
-- `title`, `severity`, `status`, `internal_note`, `client_summary` and `published` stay editable for
-- the later lifecycle.

CREATE TABLE project_risks (
  id                 CHAR(36)      NOT NULL,
  organization_id    CHAR(36)      NOT NULL,
  -- NOT NULL. A risk belongs to a project; see the note above.
  project_id         CHAR(36)      NOT NULL,
  -- `documents.title` / `project_updates.title` are VARCHAR(300); an internal risk handle is the
  -- same kind of short label.
  title              VARCHAR(300)  NOT NULL,
  -- Client-safe facts §4 names.
  severity           ENUM('low', 'medium', 'high') NOT NULL DEFAULT 'medium',
  status             ENUM('open', 'mitigated', 'closed') NOT NULL DEFAULT 'open',
  -- The internal-only substance. Nullable — a risk may be summarised for the client without an
  -- internal note. Never projected to a client.
  internal_note      TEXT          NULL,
  -- The client-facing description — the one field of a risk a client is ever shown.
  client_summary     VARCHAR(2000) NOT NULL,
  -- The client-visibility gate. A client read selects `published = 1` only; an unpublished risk is
  -- invisible to every external principal.
  published          BOOLEAN       NOT NULL DEFAULT 0,
  created_by_user_id CHAR(36)      NOT NULL,
  created_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                   ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path.
  UNIQUE KEY uq_project_risks_org_id (organization_id, id),
  -- 07-DATA-MODEL §9: the one read that exists — this tenant's risks for this project, newest first.
  -- Leads with `organization_id`.
  KEY ix_project_risks_org_project (organization_id, project_id, created_at),
  CONSTRAINT fk_project_risks_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_project_risks_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A risk's tenant, project and author are immutable, for the reason `project_updates`' and
-- `project_milestones`' triggers give: re-pointing a risk at another project would move it into a
-- portal a different client can read, silently. `title`, `severity`, `status`, `internal_note`,
-- `client_summary` and `published` are editable (the lifecycle is a later slice); identity is not.
DELIMITER $$

CREATE TRIGGER trg_project_risks_immutable
BEFORE UPDATE ON project_risks FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_risks.organization_id is immutable';
  END IF;
  IF NEW.project_id <> OLD.project_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_risks.project_id is immutable';
  END IF;
  IF NEW.created_by_user_id <> OLD.created_by_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'project_risks.created_by_user_id is immutable';
  END IF;
END$$

DELIMITER ;
