-- 0016_file_object_links — the object an upload belongs to, and the identity the review found
-- unpinned (FILE-001, after the review fleet).
--
-- Governing sources: contracts/openapi.yaml (`CreateUploadSessionRequest.objectId` — "the
-- request, message or deliverable the file belongs to"); 25-AUTHORIZATION-AND-TENANT-ISOLATION
-- §7 (client responses never carry internal file keys) and ADR-0001 layer 5 (identity is
-- immutable at the engine); 49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY §6 step 2 (authorize the
-- project/object before reserving).
--
-- ## `object_id`, authorized and then dropped
--
-- 0015's service required a client to name the request a file belongs to, checked that the
-- request was theirs, and then stored nothing of it: `upload_sessions` and `file_assets` had
-- no column for the object, so `request_attachment` was a purpose no row could resolve and
-- WEB-006's "files on this request" had no join to make. Both tables now carry `object_id`.
-- It is nullable because `deliverable` and `message_attachment` name their object later (a
-- deliverable version is created from a file version, not the other way round), and it has
-- no foreign key because which table it names depends on `purpose` — `purpose-policy.ts`'s
-- `objectTableFor` is the one place that mapping is spelled.
--
-- ## What the triggers did not pin
--
-- 0015's `trg_upload_sessions_immutable` pinned the tenant key, the project, the asset, the
-- idempotency key, the declared bytes and the object key — and not `actor_user_id`, which the
-- service makes the whole per-row authorization. `trg_file_assets_immutable` pinned neither
-- `client_organization_id` (the column 0015's own comment calls "what stops Atlas reading a
-- file Meridian attached") nor `audience`. The composite foreign keys refuse a *cross-tenant*
-- value; nothing refused repointing a file from one client to another inside a studio. Both
-- triggers are recreated with those columns, and with `object_id`, pinned. Nullable columns
-- are compared with the null-safe `<=>`, because `NULL <> x` is NULL and an `IF` on it never
-- fires.
--
-- ## A correction to 0015's header
--
-- 0015 §"`object_key` is internal" rests the key's safety on "`FORBIDDEN_CLIENT_FIELDS` names
-- `storageKey`". It did, and this slice named the field `objectKey`, so the sweep matched
-- nothing this slice produced. The list now names `objectKey` and `providerUploadId` as well;
-- the actual mechanism remains the explicit allowlisted views, as `audience.ts` says.

ALTER TABLE upload_sessions
  ADD COLUMN object_id CHAR(36) NULL AFTER purpose,
  ADD KEY ix_upload_sessions_org_object (organization_id, object_id);

ALTER TABLE file_assets
  ADD COLUMN object_id CHAR(36) NULL AFTER purpose,
  ADD KEY ix_file_assets_org_object (organization_id, object_id);

DROP TRIGGER IF EXISTS trg_file_assets_immutable;
DROP TRIGGER IF EXISTS trg_upload_sessions_immutable;

DELIMITER $$

CREATE TRIGGER trg_file_assets_immutable
BEFORE UPDATE ON file_assets FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_assets.organization_id is immutable';
  END IF;
  IF NEW.project_id <> OLD.project_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_assets.project_id is immutable';
  END IF;
  IF NOT (NEW.client_organization_id <=> OLD.client_organization_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_assets.client_organization_id is immutable';
  END IF;
  IF NEW.owner_user_id <> OLD.owner_user_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_assets.owner_user_id is immutable';
  END IF;
  IF NEW.purpose <> OLD.purpose THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_assets.purpose is immutable';
  END IF;
  IF NEW.audience <> OLD.audience THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_assets.audience is immutable';
  END IF;
  IF NOT (NEW.object_id <=> OLD.object_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_assets.object_id is immutable';
  END IF;
END$$

CREATE TRIGGER trg_upload_sessions_immutable
BEFORE UPDATE ON upload_sessions FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'upload_sessions.organization_id is immutable';
  END IF;
  IF NEW.project_id <> OLD.project_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'upload_sessions.project_id is immutable';
  END IF;
  IF NOT (NEW.client_organization_id <=> OLD.client_organization_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'upload_sessions.client_organization_id is immutable';
  END IF;
  IF NEW.actor_user_id <> OLD.actor_user_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'upload_sessions.actor_user_id is immutable';
  END IF;
  IF NEW.file_asset_id <> OLD.file_asset_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'upload_sessions.file_asset_id is immutable';
  END IF;
  IF NEW.idempotency_key <> OLD.idempotency_key THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'upload_sessions.idempotency_key is immutable';
  END IF;
  IF NOT (NEW.object_id <=> OLD.object_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'upload_sessions.object_id is immutable';
  END IF;
  IF NEW.declared_bytes <> OLD.declared_bytes THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'upload_sessions.declared_bytes is immutable';
  END IF;
  IF NEW.object_key <> OLD.object_key THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'upload_sessions.object_key is immutable';
  END IF;
END$$

DELIMITER ;
