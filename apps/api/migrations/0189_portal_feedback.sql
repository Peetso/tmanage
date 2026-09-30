-- 0189_portal_feedback — a client contact's feedback on a published deliverable version (x321).
--
-- Governing sources: 38-MODULE-MAP §Client Portal (deliverable feedback), 22-SCREEN-BY-SCREEN
-- §Portal deliverables, 12-PERMISSION-MATRIX §1 (`client_projection.read` is the one read a client
-- holds), 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC §6 (composite tenant keys), 07-DATA-MODEL §9
-- (every composite index begins with organization_id). Builds on the client_projections heart of
-- 0031 (x97) and the deliverable_versions identity of 0027 (x92).
--
-- ## What this table is
--
-- A `portal_feedback` row is one client contact's rating (1–5) and optional comment on one
-- *published* `deliverable_versions` row — the client-authored counterpart to the immutable
-- `client_projections` (0031) the client is allowed to read. It is distinct from
-- `project_update_comments` (x203): that is an internal comment on a project *update*; this is a
-- client write on a deliverable *version*, and it is the first client write the portal makes onto a
-- deliverable. The service resolves the client-visible version through the x114 projection
-- (`findLatestByDeliverable`) before it ever writes, so an unpublished, cross-tenant or off-client
-- deliverable is a 404 and never reaches this table.
--
-- ## One feedback per contact per version
--
-- `uq_portal_feedback_org_version_contact (organization_id, deliverable_version_id,
-- client_contact_user_id)` is the upsert key: `INSERT ... ON DUPLICATE KEY UPDATE` sets or revises
-- one contact's single feedback for a version, and the unique key makes a second row impossible. A
-- contact revising their rating is an edit in place, not a growing list.
--
-- ## Bound within the tenant
--
-- `fk_portal_feedback_version_tenant` binds `(organization_id, deliverable_version_id)` to
-- `deliverable_versions (organization_id, id)`, so a cross-tenant `deliverable_version_id` does not
-- exist as a pair even when both ids exist individually — the engine half of the trap the service
-- also enforces in code. `fk_portal_feedback_contact` binds the author to a real user.
--
-- ## Rating is bounded, and identity is immutable
--
-- The service refuses a rating outside 1–5 with 400 before the write; the `chk_portal_feedback_rating`
-- CHECK is the same rule at the engine, defence in depth for a direct SQL session. `organization_id`,
-- `deliverable_version_id` and `client_contact_user_id` are what a feedback *is*: re-pointing it at
-- another version, tenant or author is not an edit. Only `rating`, `comment` and `updated_at` may
-- change. The `BEFORE UPDATE` trigger holds identity at the engine — ADR-0001 layers 3 and 4 are
-- application-side and a direct SQL session bypasses both. The runtime credential is granted INSERT
-- and UPDATE only (scripts/db/users.sql): no DELETE.

CREATE TABLE portal_feedback (
  id                        CHAR(36)     NOT NULL,
  organization_id           CHAR(36)     NOT NULL,
  -- The published version this feedback is about. The composite FK below binds it within the tenant.
  deliverable_version_id    CHAR(36)     NOT NULL,
  -- The client contact who authored it — the session's user id, never a body field.
  client_contact_user_id    CHAR(36)     NOT NULL,
  -- 1–5. The service bounds it before write; the CHECK is the same rule at the engine.
  rating                    TINYINT      NOT NULL,
  -- Optional free text; NULL when the contact left a rating only.
  comment                   TEXT         NULL,
  created_at                DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_portal_feedback_org_id (organization_id, id),
  -- One feedback per contact per version: the upsert key. A second row for the same trio is
  -- impossible, so a contact revises in place.
  UNIQUE KEY uq_portal_feedback_org_version_contact
    (organization_id, deliverable_version_id, client_contact_user_id),
  -- 07-DATA-MODEL §9: a version's feedback, newest-first — the staff read.
  KEY ix_portal_feedback_org_version
    (organization_id, deliverable_version_id, created_at),
  CONSTRAINT chk_portal_feedback_rating CHECK (rating BETWEEN 1 AND 5),
  -- The version is bound within the same tenant: the composite target is
  -- deliverable_versions (organization_id, id).
  CONSTRAINT fk_portal_feedback_version_tenant
    FOREIGN KEY (organization_id, deliverable_version_id)
    REFERENCES deliverable_versions (organization_id, id),
  CONSTRAINT fk_portal_feedback_contact
    FOREIGN KEY (client_contact_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

-- A feedback's tenant, version and author are immutable: re-pointing any of them would silently
-- change what the row is and who wrote it. Only `rating`, `comment` and `updated_at` are edited in
-- place through the upsert; the trigger guards a direct SQL session all the same.
CREATE TRIGGER trg_portal_feedback_immutable
BEFORE UPDATE ON portal_feedback FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'portal_feedback.organization_id is immutable';
  END IF;
  IF NEW.deliverable_version_id <> OLD.deliverable_version_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'portal_feedback.deliverable_version_id is immutable';
  END IF;
  IF NEW.client_contact_user_id <> OLD.client_contact_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'portal_feedback.client_contact_user_id is immutable';
  END IF;
END$$

DELIMITER ;
