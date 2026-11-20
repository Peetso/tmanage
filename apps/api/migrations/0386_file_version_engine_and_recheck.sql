-- 0386_file_version_engine_and_recheck — which engine and signature set judged a version, and when
-- a newer signature set last re-checked it (QA-FIX lane N, finding S1, 2026-11-20).
--
-- Why: a `clean` verdict is write-once (0019) and said nothing about the signatures behind it, so a
-- file cleared before a signature update stayed "Virus-scanned" for ever. Three nullable columns:
--
--   `scan_engine_version`        the engine's own answer at the verdict (clamd `VERSION`, e.g.
--                                `ClamAV 1.5.4/28189/Fri Nov 20 06:29:13 2026`); NULL for verdicts
--                                written before 0386 and for the `none` driver.
--   `checked_signature_version`  the signature-database number (`28189`) the bytes were last
--                                checked against, by the first scan or by the re-check pass
--                                (`files/file-rescanner.ts`). NULL = never checked against a known
--                                signature set, which the re-check pass treats as out of date.
--   `checked_at`                 when that last check happened (a bound `Date`, DA-10).
--
-- Not pinned by `trg_file_versions_immutable` (0019 pins its listed columns only): the verdict
-- trio stays write-once, and a later detection is recorded on the asset (`ready → rejected`,
-- `rejection_code = malware_detected`) and in the audit log, never by rewriting the verdict.
--
-- MariaDB-safe (live is MariaDB 11.8, DA-5): plain nullable ADD COLUMN and one secondary index,
-- no ENUM, no generated column, no CHECK, no IF NOT EXISTS. Online on both engines (DA-7). Expand
-- only (DA-6): the previous release ignores the columns. No new grant: the existing UPDATE grant on
-- `file_versions` covers it (users.sql carries a 0386 comment line).

ALTER TABLE file_versions
  ADD COLUMN scan_engine_version VARCHAR(96) NULL,
  ADD COLUMN checked_signature_version INT UNSIGNED NULL,
  ADD COLUMN checked_at DATETIME(3) NULL,
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE file_versions
  ADD KEY ix_file_versions_org_verdict_checked (organization_id, scan_verdict, checked_signature_version),
  ALGORITHM=INPLACE, LOCK=NONE;
