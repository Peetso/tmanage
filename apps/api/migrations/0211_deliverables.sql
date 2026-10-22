-- 0211_deliverables — the deliverable aggregate behind client approval (audit gap 1, APR-01/02).
--
-- Until now `deliverable_versions.deliverable_id` was a logical reference with no row behind it
-- (0027: "the deliverable aggregate is domain-only"), and nothing in the API created a version, so
-- the client Approve screen could never be reached. This adds:
--
-- 1. `deliverables` — one named piece of work on a project (title, optional description). It is
--    the thing a team member creates, uploads versions to and sends to the client for approval.
--    No lifecycle column: the state the screens show (draft / in review / changes requested /
--    approved) is derived from the newest version's approval, so it can never disagree with the
--    append-only `approvals` record.
-- 2. Three nullable columns on `deliverable_versions`: `version_no` (1, 2, 3 … per deliverable),
--    the attached file (`file_asset_id`, `file_version_id` — the exact file version the client
--    saw) and the team's `note` for that version. Nullable because rows written before this
--    migration have none; an ALTER does not fire 0027's UPDATE trigger, and the repository still
--    never updates a version. The UNIQUE key on (organization_id, deliverable_id, version_no)
--    allows the legacy NULLs (NULLs never collide) and stops two "version 2"s racing in.
--
-- No foreign key from `deliverable_versions.deliverable_id` to `deliverables`: fixture and legacy
-- versions exist without a deliverable row, and adding the key would fail on them. The service
-- creates a version only for a deliverable it has just read tenant-scoped.
--
-- Tenant-owned (TENANT_TABLES). MariaDB-safe: no generated columns, no CHECK, no JSON functions;
-- ADD COLUMN / ADD UNIQUE KEY in one ALTER, which MariaDB 10.x and MySQL 8 both accept.
CREATE TABLE deliverables (
  id                  CHAR(36)      NOT NULL,
  organization_id     CHAR(36)      NOT NULL,
  project_id          CHAR(36)      NOT NULL,
  title               VARCHAR(300)  NOT NULL,
  description         TEXT          NULL,
  created_by_user_id  CHAR(36)      NOT NULL,
  created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_deliverables_org_id (organization_id, id),
  KEY ix_deliverables_org_project (organization_id, project_id, created_at),
  CONSTRAINT fk_deliverables_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_deliverables_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE deliverable_versions
  ADD COLUMN version_no      INT UNSIGNED NULL AFTER deliverable_id,
  ADD COLUMN file_asset_id   CHAR(36)     NULL AFTER content_hash,
  ADD COLUMN file_version_id CHAR(36)     NULL AFTER file_asset_id,
  ADD COLUMN note            TEXT         NULL AFTER file_version_id,
  ADD UNIQUE KEY uq_deliverable_versions_org_deliverable_no
    (organization_id, deliverable_id, version_no);
