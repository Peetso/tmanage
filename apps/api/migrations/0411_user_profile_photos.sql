-- 0411_user_profile_photos — a person's own profile photo (owner, 2026-11-23: "why can't I change
-- my profile picture?").
--
-- Why not `users.avatar_file_asset_id` (the brief's first idea, the group-photo pattern): every
-- `file_assets` row is tenant-owned and filed under a project (`organization_id` and `project_id`
-- are NOT NULL), so a photo held there would live in one company's project, count against that
-- company's storage, show in its file lists, and be invisible to the person's other companies and
-- to their client portal. 0229 met the same wall for the company logo and gave the logo its own
-- table; a person's photo belongs to the person, so its table is global like `users` itself.
--
-- `user_avatars`: one row per person who has a photo. The route never stores what was sent: it
-- checks the bytes (JPEG, PNG or WebP by signature), scans them when a malware engine is set,
-- decodes them to pixels and writes two new WebP squares (256 px and 64 px). Re-encoding from
-- pixels is what removes EXIF, GPS and any trailing payload. `sha256` is the digest of the 256 px
-- image; its first 16 hex characters are the cache key in the image URL, so a changed photo is a
-- new URL and an unchanged one may be cached for a long time. No foreign key (the brief): the
-- account erasure deletes the row by `user_id` (`AccountErasure`, privacy-erasure.repository.ts).
--
-- `member_photo_removals`: a company owner or admin removed a member's offensive photo in THEIR
-- company. Tenant-owned: one company cannot change how a person looks in another company (the
-- x216 rule that keeps an admin from renaming a person everywhere). The removal names the photo by
-- digest, so it holds until the person uploads a different photo; uploading the same picture again
-- stays removed. The person's own Profile page says so.
--
-- MariaDB-safe: plain CREATE TABLE, no CHECK, no generated column, no expression default, no
-- foreign key; the trigger uses `<=>`.

CREATE TABLE user_avatars (
  user_id            CHAR(36)          NOT NULL,
  sha256             CHAR(64)          NOT NULL,
  -- WebP, base64. The 256 px square is a few tens of KB; the 64 px one a few KB.
  image_256_base64   MEDIUMTEXT        NOT NULL,
  image_64_base64    MEDIUMTEXT        NOT NULL,
  created_at         DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                       ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE member_photo_removals (
  id                 CHAR(36)          NOT NULL,
  organization_id    CHAR(36)          NOT NULL,
  user_id            CHAR(36)          NOT NULL,
  -- The digest of the photo that was removed (`user_avatars.sha256` at the time).
  photo_sha256       CHAR(64)          NOT NULL,
  removed_by         CHAR(36)          NOT NULL,
  created_at         DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                       ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_member_photo_removals_org_id (organization_id, id),
  -- One removal per person per company: the upsert key.
  UNIQUE KEY uq_member_photo_removals_org_user (organization_id, user_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A removal row cannot be re-pointed at another company or person by a direct SQL session.
DELIMITER $$

CREATE TRIGGER trg_member_photo_removals_pin_identity
BEFORE UPDATE ON member_photo_removals FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id)
     OR NOT (NEW.organization_id <=> OLD.organization_id)
     OR NOT (NEW.user_id <=> OLD.user_id)
     OR NOT (NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'member_photo_removals identity is immutable';
  END IF;
END$$

DELIMITER ;
