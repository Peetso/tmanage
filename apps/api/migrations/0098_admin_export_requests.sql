-- 0098_admin_export_requests — a recorded request to export a studio's data, so an administrator can
-- ask for a GDPR-style whole-org export and track its status (Administration & governance, module 18,
-- x224).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Administration & governance (GDPR-style
-- export request); migration 0090 (insight_snapshots) for the shape of a tenant-owned, append-only
-- record with the (organization_id, id) isolation key; ADR-0001 layer 3.
--
-- ## Distinct from the audit CSV export (x197)
--
-- x197 built the audit-log CSV export — a synchronous read of the audit trail. This is a different
-- flow: a *request record* for a whole-org data export. The bulk export file generation and delivery
-- (an async worker plus storage/egress) is Needs-Peter and is NOT part of this slice — this table only
-- records that an export was requested and lets an admin see its status. No file is produced here and
-- nothing leaves the system, so the record-only shape avoids the data-egress path entirely.
--
-- ## Migration number
--
-- The pass-23 queue reserves 0098 for x224. The migrator applies files in ascending numeric order and
-- a gap is not an error (it rejects only a NEW file numbered below an applied one), so 0098 is correct
-- on this base; nothing here depends on the literal number beyond the filename.
--
-- ## Tenant-owned, and immutable once recorded
--
-- A request belongs to exactly one organization: it carries `organization_id`, the composite
-- `(organization_id, id)` isolation key every tenant-scoped table carries (isolation corpus requires
-- it), and a foreign key to `organizations`. It is registered in the tenant guard's `TENANT_TABLES`
-- (tenant-guard.ts) so the layer-3 guard refuses any unscoped read or write of it.
--
-- A request is a historical fact: it is recorded (INSERT) and read (the database-wide SELECT), never
-- edited or removed by the runtime API credential — so `scripts/db/users.sql` grants `tmanage_app`
-- INSERT and nothing else, and the trigger below refuses to move `organization_id`, `scope`,
-- `requested_by` or `requested_at`. The status column is created `pending`; moving a request through
-- its lifecycle (processing/completed/failed) is the Needs-Peter worker's job with a privilege it is
-- granted alongside the code that writes it — the withheld UPDATE keeps the record honest until then.
--
-- ## requested_at is bound, not the connection clock
--
-- `requested_at` is written from a value the application binds (a `Date` resolved once in the
-- controller), NOT `CURRENT_TIMESTAMP` — the admin-pool clock trap: the recorded instant must be the
-- moment the admin asked, not whatever the writing connection's clock reads. The column therefore has
-- no default; the writer always supplies it.

CREATE TABLE admin_export_requests (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- What the export covers, a closed vocabulary mirrored by `ADMIN_EXPORT_SCOPES` in schema.ts:
  -- `full` (the whole organization), `members`, `projects`, `work_items`, `billing`. An unknown scope
  -- is a 400 in the controller, never a stored row.
  scope           ENUM('full','members','projects','work_items','billing') NOT NULL,
  -- The request lifecycle. Created `pending`; the later async worker moves it through
  -- `processing`/`completed`/`failed`. This slice only ever writes `pending`.
  status          ENUM('pending','processing','completed','failed') NOT NULL DEFAULT 'pending',
  -- The user who asked for the export (a global user id, not a membership — a request is attributed to
  -- the person). No FK to users (a GLOBAL table): attribution is recorded, not enforced relationally.
  requested_by    CHAR(36)     NOT NULL,
  -- The instant the admin asked, bound by the application (see the header). Requests are ordered and
  -- listed by this, so it is NOT NULL and has no server-clock default.
  requested_at    DATETIME(3)  NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries (isolation corpus requires it),
  -- and the key a by-id read joins on so a request can never be fetched across a tenant boundary.
  UNIQUE KEY uq_admin_export_requests_org_id (organization_id, id),
  -- The index the status screen lists by: this organization's requests, newest first, with id as the
  -- keyset tiebreak. Leads with `organization_id` per 07-DATA-MODEL §9.
  KEY ix_admin_export_requests_org_requested (organization_id, requested_at, id),
  CONSTRAINT fk_admin_export_requests_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A request's tenant and the facts of what was asked, by whom and when are immutable; only a later
-- worker's `status` may change (and only with the UPDATE grant it is given with that code). The
-- trigger holds the identity and request facts at the engine, the reason every other identity trigger
-- in this schema exists.
DELIMITER $$
CREATE TRIGGER trg_admin_export_requests_immutable
BEFORE UPDATE ON admin_export_requests FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'admin_export_requests.organization_id is immutable';
  END IF;
  IF NEW.scope <> OLD.scope THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'admin_export_requests.scope is immutable';
  END IF;
  IF NEW.requested_by <> OLD.requested_by THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'admin_export_requests.requested_by is immutable';
  END IF;
  IF NEW.requested_at <> OLD.requested_at THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'admin_export_requests.requested_at is immutable';
  END IF;
END$$
DELIMITER ;
