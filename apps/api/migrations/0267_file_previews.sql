-- 0267_file_previews — the derivatives TManage makes of an uploaded version (R4 slice 2; SPEC R4
-- §3.1). The in-browser proofing viewer shows most formats natively; for the rest the server makes
-- small, safe copies: a sanitised SVG, a thumbnail, a page image, a flattened PSD, a ZIP listing,
-- the metadata a media or Office file needs to be laid out. One row per derivative.
--
-- ## What a row says
--
-- `(file_version_id, kind, page_no)` is one derivative of one uploaded version. `page_no` is 0 for
-- a derivative of the whole file and 1, 2 … for a per-page one (`page_thumb`). It is NOT NULL on
-- purpose: a unique key treats every NULL as distinct, so a NULL page would let two `thumb` rows of
-- one version stand side by side — the SPEC's NULL is replaced by 0 for that reason.
--
-- `status` is `pending` (queued, or claimed by a running pass — `claimed_at`), `ready` (the bytes
-- are in the `derived` zone under `object_key`), `failed` (after the job's third attempt, with
-- `error_code`) or `unsupported` (the generator cannot make it here, e.g. too large). Closed list
-- checked in the application (`file-previews.repository.ts`), as 0265 does.
--
-- `object_key` is a storage literal — `tenant/{org}/derivative/{version}/{preview id}` — and never
-- leaves the API (`FORBIDDEN_CLIENT_FIELDS` names `objectKey`). It is NULL until the derivative is
-- written, then write-once: a regeneration writes the same key again (the key is built from the
-- row's own id), so a changed key would only ever be a bug that strands bytes on disk.
--
-- `meta` is the generator's description of what it made (page sizes, duration, codecs, layer
-- tree, ZIP entries, slide size, an "approximate" flag). Read with JSON_EXTRACT only, never `->`.
-- Derivatives carry no personal data: they are made from a file, they are not about anyone.
--
-- ## Immutability
--
-- A row's identity — organization, asset, version, kind, page, creation time — never changes
-- (trigger). Status, claim, attempts, size and meta move as the job works. DELETE is granted: a
-- purged version's derivatives are swept (a later slice), and the company erasure removes the
-- rows and, through `OBJECT_SOURCES`, the bytes.
--
-- ## MariaDB-safe (live is MariaDB 11.8)
--
-- CHAR(36) ids, `(organization_id, id)` unique, composite tenant foreign keys, DATETIME(3), a JSON
-- column without a default, no generated column, no CHECK, no functional index, utf8mb4_unicode_ci.

CREATE TABLE file_previews (
  id               CHAR(36)         NOT NULL,
  organization_id  CHAR(36)         NOT NULL,
  file_asset_id    CHAR(36)         NOT NULL,
  file_version_id  CHAR(36)         NOT NULL,
  kind             VARCHAR(32)      NOT NULL,
  page_no          INT UNSIGNED     NOT NULL DEFAULT 0,
  status           VARCHAR(16)      NOT NULL DEFAULT 'pending',
  object_key       VARCHAR(512)     NULL,
  mime_type        VARCHAR(150)     NULL,
  size_bytes       BIGINT UNSIGNED  NULL,
  width            INT UNSIGNED     NULL,
  height           INT UNSIGNED     NULL,
  meta             JSON             NULL,
  error_code       VARCHAR(64)      NULL,
  attempts         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  claimed_at       DATETIME(3)      NULL,
  created_at       DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_file_previews_org_id (organization_id, id),
  -- One derivative of a kind per page of a version: two passes inserting the same row collide.
  UNIQUE KEY uq_file_previews_version_kind_page (organization_id, file_version_id, kind, page_no),
  -- The job's queue read: pending rows nobody holds, oldest first.
  KEY ix_file_previews_pending (status, claimed_at, created_at),
  -- The viewer manifest's read: every derivative of one asset.
  KEY ix_file_previews_asset (organization_id, file_asset_id),
  CONSTRAINT fk_file_previews_asset
    FOREIGN KEY (organization_id, file_asset_id) REFERENCES file_assets (organization_id, id),
  CONSTRAINT fk_file_previews_version
    FOREIGN KEY (organization_id, file_version_id) REFERENCES file_versions (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

CREATE TRIGGER trg_file_previews_identity
BEFORE UPDATE ON file_previews FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.file_asset_id <> OLD.file_asset_id
     OR NEW.file_version_id <> OLD.file_version_id
     OR NEW.kind <> OLD.kind
     OR NEW.page_no <> OLD.page_no
     OR NEW.created_at <> OLD.created_at THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'file_previews identity columns are immutable';
  END IF;
  IF OLD.object_key IS NOT NULL AND NOT (NEW.object_key <=> OLD.object_key) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'file_previews.object_key is write-once';
  END IF;
END$$

DELIMITER ;
