-- 0080_maintenance_windows — the platform maintenance / degraded-mode window (Platform states,
-- module 21, x185).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Platform states (maintenance);
-- AUDIT-2026-09-27 (Platform states Partial — maintenance/degraded state absent); migration 0060
-- (incidents) and 0020 (credential_change_notices) for the shape of a deliberately GLOBAL, org-less
-- table and why it lives in NON_TENANT_TABLES rather than TENANT_TABLES; ADR-0001 layer 3.
--
-- ## Migration number
--
-- Pass 21 reserves 0060–0080 in slice-id order; x185's reservation is 0080 (pass21-queue header).
-- The highest migration present on this slice's base (master bcfe397) is 0052; 0053–0079 are
-- reserved by sibling pass-21 branches not yet integrated, so 0080 sits above every reservation.
-- The migrator applies files in ascending numeric order and a gap is not an error (it rejects only a
-- NEW file numbered below an applied one), so 0080 on top of 0052 is correct on this base.
--
-- ## Global, not tenant-owned
--
-- A maintenance window announces that the whole platform is going into maintenance or a degraded
-- state. It is read by the app shell before — and independently of — any organization, and it
-- describes the service as a whole rather than one customer's tenant. So there is NO
-- `organization_id`, no composite tenant key and no tenant foreign key — the same decision
-- `incidents` (0060) and `credential_change_notices` (0020) make. The table is registered in
-- `NON_TENANT_TABLES` (apps/api/src/common/database/tenant-guard.ts), so the layer-3 guard treats an
-- unscoped read of it as legitimate rather than a leak, and the public read runs on the identity path.
--
-- ## Published-only is the public-visibility gate
--
-- A window may be drafted (`published = 0`) before it is announced; the public read selects
-- `published = 1` only, the way `incidents` (0060) and `project_updates` (0041) gate visible content.
-- Unlike the READ-only `incidents` slice, x185 also ships the admin WRITE path, so `maintenance_windows`
-- carries an INSERT grant for the runtime user (scripts/db/users.sql) — but no UPDATE or DELETE: a
-- window is scheduled and read, never amended in place in this slice.

CREATE TABLE maintenance_windows (
  id          CHAR(36)     NOT NULL,
  -- The public write-up the banner shows. Prose a person reads, so TEXT and NOT NULL.
  message     TEXT         NOT NULL,
  -- The severity the banner renders, a closed vocabulary mirrored by `MAINTENANCE_SEVERITIES`
  -- in schema.ts: `info` (a notice), `degraded` (partial service), `down` (full maintenance).
  severity    ENUM('info','degraded','down') NOT NULL,
  -- The window's bounds, DATETIME(3) instants. The write validates `starts_at < ends_at`; the read
  -- treats the window as active when `starts_at <= now < ends_at`.
  starts_at   DATETIME(3)  NOT NULL,
  ends_at     DATETIME(3)  NOT NULL,
  -- The public-visibility gate: the public read selects `published = 1` only, so a draft window is
  -- never announced.
  published   BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The public read's index: the published windows in end order. Leading with `published` keeps the
  -- shown set contiguous, and `ends_at` lets the read find the current-or-next window cheaply.
  KEY ix_maintenance_windows_published_ends (published, ends_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
