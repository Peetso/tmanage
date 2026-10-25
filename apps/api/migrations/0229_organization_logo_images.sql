-- 0229_organization_logo_images — the company logo, held by the organization itself (C6).
--
-- 0224 made the logo an ordinary `org_logo` upload, but every upload is filed under a project
-- (`file_assets.project_id` is NOT NULL with a foreign key to `projects`), so the card filed the
-- logo under the organization's first project: an organization with no project could not set a
-- logo at all, and a member who was not on that project could not see it. This table is the
-- organization-scoped home for the logo: one row per organization, no project.
--
-- The image is small (the route caps it at 512 KiB) and is stored here, base64 in a MEDIUMTEXT,
-- after the route has checked it: PNG, JPEG and WebP by their signature at offset zero, SVG only
-- after the server-side sanitiser has rebuilt it from an allowlist (no scripts, no event handlers,
-- no external references, no foreignObject). What is stored is the sanitised output, never the
-- bytes that were sent. `sha256` is the digest of the stored bytes; `version` moves on every
-- replace so the screens can cache by it.
--
-- `organizations.logo_file_id` (0224) stays: a logo set the old way keeps showing until it is
-- replaced or removed.
--
-- MariaDB-safe: plain CREATE TABLE, no CHECK, no generated column. The trigger uses `<=>`.

CREATE TABLE organization_logos (
  id                 CHAR(36)          NOT NULL,
  organization_id    CHAR(36)          NOT NULL,
  -- One of image/png, image/jpeg, image/webp, image/svg+xml — decided by the route from the bytes.
  mime_type          VARCHAR(32)       NOT NULL,
  size_bytes         INT UNSIGNED      NOT NULL,
  sha256             CHAR(64)          NOT NULL,
  content_base64     MEDIUMTEXT        NOT NULL,
  version            BIGINT UNSIGNED   NOT NULL DEFAULT 1,
  updated_by         CHAR(36)          NOT NULL,
  created_at         DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                       ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_organization_logos_org_id (organization_id, id),
  -- One logo per organization: the upsert key.
  UNIQUE KEY uq_organization_logos_org (organization_id),
  CONSTRAINT fk_organization_logos_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_organization_logos_updated_by
    FOREIGN KEY (updated_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A logo row cannot be re-pointed at another organization by a direct SQL session.
DELIMITER $$

CREATE TRIGGER trg_organization_logos_pin_identity
BEFORE UPDATE ON organization_logos FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id)
     OR NOT (NEW.organization_id <=> OLD.organization_id)
     OR NOT (NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_logos identity is immutable';
  END IF;
END$$

DELIMITER ;
