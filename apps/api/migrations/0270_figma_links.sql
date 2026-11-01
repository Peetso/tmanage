-- 0270_figma_links — Figma frames in the proofing viewer (R4 slice 13; SPEC R4 §3.1, §3.5).
--
-- ## figma_connections
--
-- One row per member who pasted a Figma personal access token. The token is stored only as the
-- SeedCipher envelope (AES-256-GCM, additional data = the membership's own binding), so a dump of
-- this table opens nothing. `token_hint` is the last four characters, the one part ever echoed
-- back ("…ab12"). `status` is `connected` or `error` (Figma refused the token on a later call).
--
-- ## figma_links
--
-- A Figma file (and the frames picked from it) attached to a project, optionally to a work item,
-- deliverable version or request. `audience` decides whether the client sees it in the portal
-- (`client_visible`) or not (`internal`); it never changes after creation (trigger), as for review
-- threads. Soft delete per PA-03 (`deleted_at` + `purge_after`).
--
-- ## figma_frames
--
-- One frame (Figma node) of a link, with its last snapshot: a PNG TManage stored in the `derived`
-- zone (`snapshot_object_key`, never leaves the API) and its SHA-256. `width`/`height` are the
-- node's size at the last snapshot; a later snapshot at another size sets `size_changed = 1`, the
-- "Frame changed" badge. Review threads on a frame hang on `review_threads.subject_type =
-- 'figma_frame'`, `subject_id = figma_frames.id` (0268).
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- CHAR(36) ids, `(organization_id, id)` unique, composite tenant foreign keys, DATETIME(3), no
-- generated column, no CHECK, no functional index, literal defaults, utf8mb4_unicode_ci.

CREATE TABLE figma_connections (
  id                  CHAR(36)       NOT NULL,
  organization_id     CHAR(36)       NOT NULL,
  membership_id       CHAR(36)       NOT NULL,
  token_ciphertext    VARCHAR(1024)  NOT NULL,
  token_hint          VARCHAR(8)     NOT NULL,
  figma_user_handle   VARCHAR(190)   NULL,
  status              VARCHAR(16)    NOT NULL DEFAULT 'connected',
  created_at          DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_figma_connections_org_id (organization_id, id),
  UNIQUE KEY uq_figma_connections_member (organization_id, membership_id),
  CONSTRAINT fk_figma_connections_membership
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE figma_links (
  id                        CHAR(36)       NOT NULL,
  organization_id           CHAR(36)       NOT NULL,
  project_id                CHAR(36)       NOT NULL,
  file_key                  VARCHAR(128)   NOT NULL,
  file_name                 VARCHAR(300)   NULL,
  url                       VARCHAR(1000)  NOT NULL,
  attached_to_type          VARCHAR(24)    NULL,
  attached_to_id            CHAR(36)       NULL,
  audience                  VARCHAR(16)    NOT NULL DEFAULT 'internal',
  created_by_membership_id  CHAR(36)       NOT NULL,
  created_at                DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at                DATETIME(3)    NULL,
  purge_after               DATETIME(3)    NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_figma_links_org_id (organization_id, id),
  KEY ix_figma_links_project (organization_id, project_id),
  KEY ix_figma_links_attached (organization_id, attached_to_type, attached_to_id),
  CONSTRAINT fk_figma_links_project
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE figma_frames (
  id                   CHAR(36)       NOT NULL,
  organization_id      CHAR(36)       NOT NULL,
  link_id              CHAR(36)       NOT NULL,
  node_id              VARCHAR(64)    NOT NULL,
  name                 VARCHAR(300)   NOT NULL,
  width                INT UNSIGNED   NOT NULL DEFAULT 0,
  height               INT UNSIGNED   NOT NULL DEFAULT 0,
  snapshot_object_key  VARCHAR(512)   NULL,
  snapshot_hash        CHAR(64)       NULL,
  snapshot_status      VARCHAR(16)    NOT NULL DEFAULT 'pending',
  snapshot_attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  claimed_at           DATETIME(3)    NULL,
  captured_at          DATETIME(3)    NULL,
  size_changed         TINYINT(1)     NOT NULL DEFAULT 0,
  sort_order           INT UNSIGNED   NOT NULL DEFAULT 0,
  created_at           DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_figma_frames_org_id (organization_id, id),
  UNIQUE KEY uq_figma_frames_node (organization_id, link_id, node_id),
  KEY ix_figma_frames_pending (snapshot_status, claimed_at),
  CONSTRAINT fk_figma_frames_link
    FOREIGN KEY (organization_id, link_id) REFERENCES figma_links (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_figma_links_identity
BEFORE UPDATE ON figma_links FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.project_id <> OLD.project_id
     OR NEW.created_by_membership_id <> OLD.created_by_membership_id
     OR NEW.created_at <> OLD.created_at THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'figma_links identity columns are immutable';
  END IF;
  IF NEW.audience <> OLD.audience THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'figma_links.audience is immutable';
  END IF;
END$$

CREATE TRIGGER trg_figma_frames_identity
BEFORE UPDATE ON figma_frames FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.link_id <> OLD.link_id
     OR NEW.node_id <> OLD.node_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'figma_frames identity columns are immutable';
  END IF;
END$$

DELIMITER ;
