-- 0090_insight_snapshots — a point-in-time capture of a computed insights metric, so a studio can
-- compare today's numbers against a stored snapshot over time (Insights & reporting, module 15,
-- x211).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Insights & reporting (audit:
-- Insights are live-only — no historical snapshots to compare over time); migration 0067
-- (automation_schedules) for the shape of a tenant-owned table with a JSON payload column and the
-- (organization_id, id) isolation key; ADR-0001 layer 3.
--
-- ## Migration number
--
-- Pass 22 reserves 0081–0093 in slice-id order; x211's reservation is 0090 (NEXT-SCOPES-14 header).
-- The migrator applies files in ascending numeric order and a gap is not an error (it rejects only a
-- NEW file numbered below an applied one), so 0090 on top of whatever base this slice carries is
-- correct.
--
-- ## Tenant-owned, and immutable once captured
--
-- A snapshot belongs to exactly one organization and freezes what its insights read returned at a
-- moment. So it carries `organization_id`, the composite `(organization_id, id)` isolation key every
-- tenant-scoped table carries (isolation corpus requires it), and a foreign key to `organizations`.
-- It is registered in the tenant guard's `TENANT_TABLES` (tenant-guard.ts) so the layer-3 guard
-- refuses any unscoped read or write of it.
--
-- A snapshot is a historical fact: it is captured (INSERT) and read (the database-wide SELECT), never
-- edited or removed by a runtime credential — so `scripts/db/users.sql` grants `tmanage_app` INSERT
-- and nothing else, and the trigger below refuses to move `organization_id`, `kind`, `captured_at` or
-- the payload for every credential besides. The withheld UPDATE/DELETE is the control that keeps the
-- history honest; a retention/purge surface is a later slice that adds the privilege with the code
-- that writes it.
--
-- ## captured_at is bound, not the connection clock
--
-- `captured_at` is written from a value the application binds (a `Date` resolved once in the
-- controller), NOT `CURRENT_TIMESTAMP` — the admin-pool clock trap: a snapshot's instant must match
-- the moment the metrics were computed, not whatever the writing connection's clock reads. The
-- column therefore has no default; the writer always supplies it.

CREATE TABLE insight_snapshots (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The report kind this snapshot froze, a closed vocabulary mirrored by `INSIGHT_SNAPSHOT_KINDS`
  -- in schema.ts: `portfolio` (the org portfolio roll-up) and `workload` (the org-wide workload
  -- roll-up). An unknown kind is a 400 in the controller, never a stored row.
  kind            ENUM('portfolio','workload') NOT NULL,
  -- The instant the metrics were computed, bound by the application (see the header). A snapshot is
  -- ordered and compared by this, so it is NOT NULL and has no server-clock default.
  captured_at     DATETIME(3)  NOT NULL,
  -- The computed metrics, stored whole as the JSON the read returned. Shape is the application's
  -- (`SnapshotView.payload`); the column keeps it opaque so a new metric field never needs a schema
  -- change here.
  payload_json    JSON         NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries (isolation corpus requires it),
  -- and the key a by-id read joins on so a snapshot can never be fetched across a tenant boundary.
  UNIQUE KEY uq_insight_snapshots_org_id (organization_id, id),
  -- The index the history screen lists by: this organization's snapshots of one kind, newest first.
  -- Leads with `organization_id` per 07-DATA-MODEL §9, then `kind` (the list filters on it) and
  -- `captured_at` descending with `id` as the keyset tiebreak.
  KEY ix_insight_snapshots_org_kind_captured (organization_id, kind, captured_at, id),
  CONSTRAINT fk_insight_snapshots_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$
CREATE TRIGGER trg_insight_snapshots_immutable
BEFORE UPDATE ON insight_snapshots FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'insight_snapshots.organization_id is immutable';
  END IF;
  IF NEW.kind <> OLD.kind THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'insight_snapshots.kind is immutable';
  END IF;
  IF NEW.captured_at <> OLD.captured_at THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'insight_snapshots.captured_at is immutable';
  END IF;
END$$
DELIMITER ;
