-- 0060_incidents — the public status page's incidents (Public & trust site, module 1, x159).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Public site (status page);
-- AUDIT-2026-09-27 rank #1 ("Public site Missing — no status page"); migration 0020
-- (credential_change_notices) and migration 0004 (authentication_events) for the shape of a
-- deliberately GLOBAL, org-less table and why it is not tenant-owned; ADR-0001 layer 3 (the
-- tenant guard, and why this table is registered in NON_TENANT_TABLES rather than TENANT_TABLES).
--
-- ## Migration number
--
-- Pass 21 reserves 0060–0080 in slice-id order; x159's reservation is 0060 (pass21-queue header).
-- The highest migration present on this slice's base (master bcfe397) is 0052; 0053–0059 are
-- reserved by sibling pass-20/21 branches not yet integrated, so 0060 sits above every reservation.
-- The migrator applies files in ascending numeric order and a gap is not an error (it rejects only a
-- NEW file numbered below an applied one), so 0060 on top of 0052 is correct on this base.
--
-- ## Global, not tenant-owned
--
-- A status page is the studio-operator's public trust surface: it is read by anyone, before any
-- organization is named, and it describes the service as a whole rather than one customer's tenant.
-- So there is NO `organization_id`, no composite tenant key and no tenant foreign key — the same
-- decision `authentication_events` (0004) and `credential_change_notices` (0020) make, and for the
-- same structural reason: the read runs on the identity path, before any `TenantContext` exists.
-- The table is registered in `NON_TENANT_TABLES` (apps/api/src/common/database/tenant-guard.ts), so
-- the layer-3 guard treats an unscoped read of it as legitimate rather than a leak, and
-- `tenant-isolation.db.test.ts` accounts for it in exactly one registry.
--
-- ## Published-only is the public-visibility gate
--
-- An incident exists as soon as it is drafted, but the public read selects `published = 1` only —
-- the way `client_projections` (0031) and `project_updates` (0041) gate client-facing content. A
-- draft incident is never shown on the public page. This slice ships the public READ only; a future
-- admin slice adds the write path (and, with it, the app write grant), so the runtime user holds no
-- INSERT/UPDATE/DELETE here — only the database-wide SELECT the public read runs through.

CREATE TABLE incidents (
  id          CHAR(36)     NOT NULL,
  -- The affected component, e.g. `API`, `Web`, `Uploads`. A short label, not a work item.
  component   VARCHAR(190) NOT NULL,
  -- The incident lifecycle, a closed vocabulary mirrored by `INCIDENT_STATUSES` in schema.ts.
  status      ENUM('investigating','identified','monitoring','resolved') NOT NULL,
  title       VARCHAR(300) NOT NULL,
  -- The public write-up. Prose a person reads, so TEXT and NOT NULL, like `documents.body`.
  body        TEXT         NOT NULL,
  -- When the incident began. A DATETIME(3) instant (it moves with the reader's zone), not a
  -- calendar DATE; the public read orders by it, newest first.
  started_at  DATETIME(3)  NOT NULL,
  -- NULL until the incident is resolved.
  resolved_at DATETIME(3)  NULL,
  -- The public-visibility gate: the read selects `published = 1` only, so a draft is never shown.
  published   BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The public read's index: the published tail in start order. Leading with `published` keeps the
  -- shown set contiguous, the shape `ix_credential_change_notices_unpublished` (0020) uses.
  KEY ix_incidents_published_started (published, started_at)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
