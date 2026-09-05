-- 0019_file_versions_scan_and_trust_zone — the scan verdict, the trust zone, the scan
-- claim, and the engine's rule that nothing is `ready` without a clean, promoted version
-- (FILE-002, slice B).
--
-- Governing sources: 23-ERD-AND-STATE-MACHINES §10 (`scanning → ready | rejected`; the
-- file is inaccessible outside the upload owner and authorized processing until `ready`);
-- 03-TECHNICAL-ARCHITECTURE §108 (malware scan; unscanned uploads are quarantined; buckets
-- by trust state); 49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY §4 (three trust zones; an
-- object is promoted once validation and scan pass) and §5 (a rejected object's bytes stay
-- counted until deletion); 26-THREAT-MODELS §79 (immutable keys, immutable verdicts);
-- 27-TEST-CATALOG SEC-06 (malware test file) and REL-05 (a scan failure leaves the file
-- quarantined and retryable); 50-BOOTSTRAP §39 (scanning is flagged or conservative in
-- private alpha); ADR-0001 layer 5 (identity immutable at the engine); ADR-0006 (the trust
-- zone is a column and the key is stable across zones).
--
-- ## What changes
--
-- Four columns on `file_versions`, all NULL or defaulted so every existing row keeps its
-- meaning: `scan_verdict` (`clean`, `infected`, `unscanned`), `scanned_at`, `scanner` (the
-- driver's token: `stub`, `clamav`, `none`), and `trust_zone` — `quarantine` for every row
-- that exists, `private` once the scan pass has sealed the object there. One column on
-- `file_assets`: `scan_claimed_at`, the scan pass's claim on a `scanning` row, the sweeper's
-- and verifier's stale-claim shape (decision 13: a claim older than fifteen minutes belongs
-- to a pass that died, and is retried).
--
-- ## The key is stable across zones (decision F1, ADR-0006)
--
-- `49` §4 lays quarantine and private objects out under different keys. This schema keeps
-- one key: `object_key` is immutable at the engine (0015, 0018), and a mutable key would
-- have been the trigger's one loophole. `trust_zone` says which zone holds the servable
-- object; the download path (slice C, FILE-003) reads it from the row and never from a
-- zone literal. Recorded as a divergence from `49` §4 in the ADR.
--
-- ## The verdict is write-once, as a unit, with one exception
--
-- `scan_verdict`, `scanned_at` and `scanner` are pinned together once written, as 0018
-- pinned `content_hash`: a second delivery, an overlapping pass or a hand edit cannot
-- change what the log says a scanner vouched for. The one exception is `unscanned` — the
-- verdict the `none` driver records under the bootstrap profile — which a real scanner may
-- later replace with a final one; a final verdict is never replaced by anything.
--
-- `trust_zone` may move exactly once, `quarantine → private`, and only in a write whose
-- verdict is `clean` (`NEW.scan_verdict`, so one UPDATE carries both). Never back, never
-- to `derived` (previews are FILE-004's own rows), never without the verdict. A version is
-- born in quarantine with no verdict: the INSERT trigger refuses a row that claims
-- otherwise, so no code path — and no grant — can create a version already private.
--
-- ## Nothing is `ready` without a clean, promoted, latest version
--
-- `trg_file_assets_ready_requires_clean_version` refuses `status = 'ready'` unless the
-- asset's **latest** version (the greatest `version_no`, in the same organization) says
-- `scan_verdict = 'clean'` and `trust_zone = 'private'`. The state machine in
-- `packages/domain` checks that a verdict is *present*, not what it says (its `requires`
-- is a presence rule), and the repository checks the value before it asks; this trigger is
-- the control that holds when both are bypassed — a direct UPDATE by any credential. The
-- latest version, not any version: "replacement creates new file version" (`23` §10), and
-- a clean first version must not vouch for an unscanned second. It reads `file_versions`
-- from a `file_assets` trigger — the first cross-table trigger here — filtered by the
-- asset's own `organization_id` as every read in this schema is.
--
-- ## What this migration does not do
--
-- It does not delete anything: a rejected object stays in quarantine and counted (`49`
-- §5, decision F4), and a promoted object exists in both zones until FILE-003 deletes the
-- quarantine copy of a `ready` version. It does not name an exit from `scanning` for an
-- asset no scanner will ever judge: under `MALWARE_SCAN_DRIVER=none` every upload parks
-- there, by Peter's delegated decision F3, and `scanning → expired` stays the machine's
-- unused edge (carried, `docs/implementation-status.md`).

ALTER TABLE file_versions
  ADD COLUMN scan_verdict VARCHAR(16)  NULL     AFTER content_hash,
  ADD COLUMN scanned_at   DATETIME(3)  NULL     AFTER scan_verdict,
  ADD COLUMN scanner      VARCHAR(64)  NULL     AFTER scanned_at,
  ADD COLUMN trust_zone   VARCHAR(16)  NOT NULL DEFAULT 'quarantine' AFTER scanner;

ALTER TABLE file_assets
  ADD COLUMN scan_claimed_at DATETIME(3) NULL AFTER rejection_code;

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
  -- Write-once (0018): NULL → value is the verification pass; anything after it is refused.
  IF OLD.content_hash IS NOT NULL AND NOT (NEW.content_hash <=> OLD.content_hash) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.content_hash is write-once';
  END IF;
  IF OLD.detected_mime_type IS NOT NULL AND NOT (NEW.detected_mime_type <=> OLD.detected_mime_type) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.detected_mime_type is write-once';
  END IF;
  -- The verdict's vocabulary, whoever writes it.
  IF NEW.scan_verdict IS NOT NULL AND NEW.scan_verdict NOT IN ('clean', 'infected', 'unscanned') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.scan_verdict is not a verdict';
  END IF;
  -- The verdict, its time and its scanner are written once, as a unit; `unscanned` is the
  -- one verdict a later scan may replace, and a final verdict is replaced by nothing.
  IF OLD.scan_verdict IS NOT NULL AND OLD.scan_verdict <> 'unscanned' AND (
       NOT (NEW.scan_verdict <=> OLD.scan_verdict)
    OR NOT (NEW.scanned_at <=> OLD.scanned_at)
    OR NOT (NEW.scanner <=> OLD.scanner)
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.scan_verdict is write-once';
  END IF;
  -- A verdict never loses its time or its scanner, and never goes back to NULL.
  IF OLD.scan_verdict IS NOT NULL AND (NEW.scan_verdict IS NULL OR NEW.scanned_at IS NULL OR NEW.scanner IS NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.scan_verdict is write-once';
  END IF;
  IF NEW.scan_verdict IS NOT NULL AND (NEW.scanned_at IS NULL OR NEW.scanner IS NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.scan_verdict needs scanned_at and scanner';
  END IF;
  -- The trust zone moves once, quarantine → private, and only with a clean verdict.
  -- Null-safe on purpose: `NEW.scan_verdict = 'clean'` is NULL, not false, for a version
  -- with no verdict, and `IF NOT (NULL)` would let the move through.
  IF NOT (NEW.trust_zone <=> OLD.trust_zone) THEN
    IF NOT (OLD.trust_zone <=> 'quarantine' AND NEW.trust_zone <=> 'private' AND NEW.scan_verdict <=> 'clean') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions.trust_zone moves only quarantine to private with a clean verdict';
    END IF;
  END IF;
END$$

CREATE TRIGGER trg_file_versions_born_in_quarantine
BEFORE INSERT ON file_versions FOR EACH ROW
BEGIN
  IF NEW.trust_zone <> 'quarantine' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions are born in quarantine';
  END IF;
  IF NEW.scan_verdict IS NOT NULL OR NEW.scanned_at IS NOT NULL OR NEW.scanner IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_versions are born without a scan verdict';
  END IF;
END$$

CREATE TRIGGER trg_file_assets_ready_requires_clean_version
BEFORE UPDATE ON file_assets FOR EACH ROW
BEGIN
  IF NEW.status = 'ready' AND OLD.status <> 'ready' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM file_versions v
       WHERE v.organization_id = NEW.organization_id
         AND v.file_asset_id = NEW.id
         AND v.scan_verdict = 'clean'
         AND v.trust_zone = 'private'
         AND v.version_no = (
           SELECT MAX(l.version_no)
             FROM file_versions l
            WHERE l.organization_id = NEW.organization_id
              AND l.file_asset_id = NEW.id
         )
    ) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'file_assets.status ready requires a clean, promoted latest version';
    END IF;
  END IF;
END$$

DELIMITER ;
