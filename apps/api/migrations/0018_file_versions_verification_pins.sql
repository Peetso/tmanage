-- 0018_file_versions_verification_pins — the verification facts, pinned once written
-- (FILE-002, slice A).
--
-- Governing sources: 23-ERD-AND-STATE-MACHINES §10 (`uploaded → verifying → scanning |
-- rejected`; the file is inaccessible outside the upload owner and authorized processing
-- until `ready`); 03-TECHNICAL-ARCHITECTURE §108 (the worker verifies checksum, MIME and
-- size; unscanned uploads are quarantined); 04-SECURITY-PRIVACY §6 (file validation uses
-- content signatures); 26-THREAT-MODELS §79 (checksum, signature allowlist, immutable keys);
-- 27-TEST-CATALOG SEC-06 and INT-12 (the content-hash third); ADR-0001 layer 5 (identity is
-- immutable at the engine).
--
-- ## What changes
--
-- Nothing about the table's shape. `file_versions.content_hash` and `detected_mime_type`
-- have been NULL columns since 0015, "written by nothing"; the verification pass now writes
-- each **once**, and this migration recreates `trg_file_versions_immutable` so that, once
-- written, neither can be rewritten by any credential — the same rule the trigger already
-- applied to the tenant key, the asset, the object key and the size. A verdict that could
-- be re-recorded would let a second delivery of the same event, or a hand-edited row,
-- change what the log says was verified; the conditional write in the repository
-- (`… WHERE content_hash IS NULL`) is the first guard, and this trigger is the one that
-- holds when a guard is forgotten. The remaining columns nothing legitimately updates —
-- `version_no`, `declared_mime_type`, `etag`, `created_at` — are pinned outright, so the
-- UPDATE grant that arrives with this slice can move exactly two values from NULL and
-- nothing else.
--
-- Nullable columns are compared with the null-safe `<=>`, as 0016 does, and the pin fires
-- only when the OLD value is not NULL: `NULL → value` is the one write the pass makes.
--
-- ## A correction to 0015's header
--
-- 0015 says, above `CREATE TABLE file_versions`, that a version is "immutable by
-- construction: no `updated_at`, no `version`, and `users.sql` grants INSERT only", and
-- `FileAssetsRepository`'s header said the trigger "refuses the UPDATE for every
-- credential". The trigger never did: it pinned four columns and admitted every other
-- UPDATE, and it was the missing grant alone that made the table immutable for the runtime
-- credential. Both sentences become false with the first grant, so both are corrected here
-- and in the repository — 0015 itself cannot be edited (the migrator refuses an applied
-- file whose checksum changed; 0016 set the precedent for correcting it from a later
-- header). From this migration on, the true statement is: a version's identity, key, size,
-- declared type, etag and number are immutable at the engine; its content hash and detected
-- type are write-once at the engine; and `users.sql` grants the runtime credential UPDATE so
-- the verification pass can make that one write.
--
-- ## What this migration does not do
--
-- No `scan_verdict`, `scanned_at`, `scanner` or `trust_zone` column: those are slice B's,
-- with the scanner port and the promotion they describe (decisions F1–F3). Nothing here
-- lets an asset reach `ready`.

DROP TRIGGER IF EXISTS trg_file_versions_immutable;

DELIMITER $$

CREATE TRIGGER trg_file_versions_immutable
BEFORE UPDATE ON file_versions FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.organization_id is immutable';
  END IF;
  IF NEW.file_asset_id <> OLD.file_asset_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.file_asset_id is immutable';
  END IF;
  IF NEW.version_no <> OLD.version_no THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.version_no is immutable';
  END IF;
  IF NEW.object_key <> OLD.object_key THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.object_key is immutable';
  END IF;
  IF NEW.size_bytes <> OLD.size_bytes THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.size_bytes is immutable';
  END IF;
  IF NEW.declared_mime_type <> OLD.declared_mime_type THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.declared_mime_type is immutable';
  END IF;
  IF NOT (NEW.etag <=> OLD.etag) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.etag is immutable';
  END IF;
  IF NEW.created_at <> OLD.created_at THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.created_at is immutable';
  END IF;
  -- Write-once: NULL → value is the verification pass; anything after it is refused.
  IF OLD.content_hash IS NOT NULL AND NOT (NEW.content_hash <=> OLD.content_hash) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.content_hash is write-once';
  END IF;
  IF OLD.detected_mime_type IS NOT NULL AND NOT (NEW.detected_mime_type <=> OLD.detected_mime_type) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.detected_mime_type is write-once';
  END IF;
END$$

DELIMITER ;
