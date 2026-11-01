-- 0269_file_review_decisions — Approve / Request changes on a plain file, and comments that travel
-- to a new version (R4 slice 11; SPEC R4 §3.1).
--
-- ## file_review_decisions
--
-- One row per decision somebody took on one version of a plain attachment (a deliverable keeps its
-- own `approvals`, 0027). `root_file_asset_id` is the chain's version 1, `file_asset_id` the
-- version decided, `file_version_id` the uploaded bytes that were on screen. Append-only: a
-- later decision is a new row and the newest row is the version's state; a new version never
-- touches the decisions on older ones, so the history stays.
--
-- `decision` is `approved` or `changes_requested` (closed list checked in the application, as 0265
-- does). A request for changes must say what to change: the BEFORE INSERT trigger refuses an empty
-- note, the way 0027 refuses empty feedback.
--
-- `decided_by_membership_id` names an internal `memberships` row or a client `client_memberships`
-- row (`principal_kind` says which), so it has no foreign key.
--
-- ## review_threads.carry_scope
--
-- A comment carried to a new version is a copy of its thread with the SAME number (so "pin 2" is
-- pin 2 on v2 and on v3). 0268's unique key allowed one row per number and subject; the key now
-- also holds `carry_scope`: '' for a thread somebody opened (numbers stay unique across the whole
-- chain, the race guard is unchanged), and the target `file_versions.id` for a carried copy (one
-- copy of a number per version). A literal '' default, not NULL, so the unique key bites.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- CHAR(36) ids, `(organization_id, id)` unique, composite tenant foreign keys, DATETIME(3), no
-- generated column, no CHECK, no functional index, literal defaults, utf8mb4_unicode_ci. The
-- 0268 identity trigger is dropped and created again with `carry_scope` in its list.

CREATE TABLE file_review_decisions (
  id                        CHAR(36)      NOT NULL,
  organization_id           CHAR(36)      NOT NULL,
  project_id                CHAR(36)      NOT NULL,
  root_file_asset_id        CHAR(36)      NOT NULL,
  file_asset_id             CHAR(36)      NOT NULL,
  file_version_id           CHAR(36)      NULL,
  decision                  VARCHAR(20)   NOT NULL,
  note                      TEXT          NULL,
  decided_by_membership_id  CHAR(36)      NOT NULL,
  decided_by_user_id        CHAR(36)      NOT NULL,
  principal_kind            VARCHAR(8)    NOT NULL,
  client_organization_id    CHAR(36)      NULL,
  created_at                DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_file_review_decisions_org_id (organization_id, id),
  -- The version's state: its newest decision.
  KEY ix_file_review_decisions_version (organization_id, file_asset_id, created_at),
  -- The chain's history, newest first.
  KEY ix_file_review_decisions_root (organization_id, root_file_asset_id, created_at),
  KEY ix_file_review_decisions_project (organization_id, project_id),
  CONSTRAINT fk_file_review_decisions_project
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_file_review_decisions_root
    FOREIGN KEY (organization_id, root_file_asset_id) REFERENCES file_assets (organization_id, id),
  CONSTRAINT fk_file_review_decisions_asset
    FOREIGN KEY (organization_id, file_asset_id) REFERENCES file_assets (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE review_threads
  ADD COLUMN carry_scope CHAR(36) NOT NULL DEFAULT '' AFTER carried_from_thread_id;

ALTER TABLE review_threads
  DROP INDEX uq_review_threads_number,
  ADD UNIQUE KEY uq_review_threads_number (organization_id, subject_type, subject_id, number, carry_scope);

DROP TRIGGER IF EXISTS trg_review_threads_identity;

DELIMITER $$

CREATE TRIGGER trg_file_review_decisions_insert
BEFORE INSERT ON file_review_decisions FOR EACH ROW
BEGIN
  IF NEW.decision = 'changes_requested' AND (NEW.note IS NULL OR TRIM(NEW.note) = '') THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'a request for changes needs a note';
  END IF;
END$$

CREATE TRIGGER trg_file_review_decisions_append_only
BEFORE UPDATE ON file_review_decisions FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'file_review_decisions rows are append-only';
END$$

CREATE TRIGGER trg_review_threads_identity
BEFORE UPDATE ON review_threads FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.project_id <> OLD.project_id
     OR NEW.subject_type <> OLD.subject_type
     OR NEW.subject_id <> OLD.subject_id
     OR NOT (NEW.file_version_id <=> OLD.file_version_id)
     OR NEW.number <> OLD.number
     OR NOT (NEW.carried_from_thread_id <=> OLD.carried_from_thread_id)
     OR NEW.carry_scope <> OLD.carry_scope
     OR NEW.created_by_membership_id <> OLD.created_by_membership_id
     OR NEW.created_at <> OLD.created_at THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'review_threads identity columns are immutable';
  END IF;
  IF NEW.audience <> OLD.audience THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'review_threads.audience is immutable';
  END IF;
END$$

DELIMITER ;
