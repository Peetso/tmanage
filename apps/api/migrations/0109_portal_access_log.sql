-- 0109_portal_access_log — a record of what a client accessed in the portal (SEC / Client portal,
-- module 13, x237).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §"Client portal", 25-AUTHORIZATION-
-- AND-TENANT-ISOLATION §6 (composite tenant keys) and §12 (append-only records), 07-DATA-MODEL §9
-- (index prefixes lead with `organization_id`).
--
-- ## What this migration is for
--
-- The portal read paths (x114 deliverables, CLIENT-003 updates, and their siblings) let a client
-- see published deliverables and updates, but the studio has no record of *what a client actually
-- looked at* — the gap this slice closes. Each row is one client access event: the project, the
-- client membership that accessed it, the kind of resource, and the instant. It is read by an
-- **internal** audit screen behind `project.manage`; it is never projected to a client.
--
-- ## Internal-only, and it carries nothing sensitive
--
-- A row holds a fixed `resource_kind` and a timestamp — no title, no body, no token, nothing a
-- client typed. The table is deliberately NOT reachable through any `client_projection.read` path:
-- a client must not be able to read its own (or anyone's) access log. That is a routing property
-- (the only read is on the internal `projects` path) reinforced by the grant below (the runtime
-- credential holds INSERT and the database-wide SELECT, nothing that a portal read handler wires).
--
-- ## Append-only
--
-- An access event is a record of something that happened; overwriting or deleting one would
-- rewrite that record silently. This slice has no edit or delete endpoint, and the row is immutable
-- at the engine — the `BEFORE UPDATE` and `BEFORE DELETE` triggers `SIGNAL` on every change, the way
-- `meeting_notes` (0033) and `audit_events` (0002) hold their append-only records. ADR-0001 layers 3
-- and 4 are application-side and a direct SQL session bypasses both, so the guarantee lives at the
-- engine.
--
-- ## Parent-owned, and tenant-scoped like every sibling
--
-- `project_id` is `NOT NULL`: an access event names the project it was recorded against. The
-- composite foreign key `fk_portal_access_log_project_tenant` binds `(organization_id, project_id)`
-- to `projects (organization_id, id)` — its `uq_projects_org_id` key — so an event can only ever
-- cite a project of its own tenant. `client_member_id` binds `(organization_id, client_member_id)`
-- to `client_memberships (organization_id, id)`, so the accessing member is likewise tenant-scoped.

CREATE TABLE portal_access_log (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- NOT NULL. The project the event was recorded against. The composite FK below binds it to a
  -- project of this tenant, so a cross-tenant id does not exist as a pair even when both ids do.
  project_id         CHAR(36)     NOT NULL,
  -- The client membership that accessed the resource — the service passes `principal.membershipId`
  -- (a client principal's membership is its `client_memberships` row). Tenant-scoped by the FK.
  client_member_id   CHAR(36)     NOT NULL,
  -- The kind of portal resource accessed. A fixed vocabulary, so an ENUM (the house pattern for a
  -- fixed vocabulary, 0001 status/audience) — recorded by the internal `record()` helper from a
  -- literal, never from client input.
  resource_kind      ENUM('project','work_item','deliverable','deliverable_file','update') NOT NULL,
  accessed_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The `(organization_id, id)` key every tenant-scoped table carries.
  UNIQUE KEY uq_portal_access_log_org_id (organization_id, id),
  -- The index the internal audit screen reads by: this tenant's events for this project, newest
  -- first. Ordering is by `id` (UUIDv7, ≈ creation order and unique), so a keyset page boundary can
  -- never repeat or skip a row. Leads with `organization_id` per 07-DATA-MODEL §9.
  KEY ix_portal_access_log_org_project (organization_id, project_id, id),
  CONSTRAINT fk_portal_access_log_project_tenant
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id),
  CONSTRAINT fk_portal_access_log_member_tenant
    FOREIGN KEY (organization_id, client_member_id) REFERENCES client_memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An access event is immutable: it is the record of what a client looked at, and this slice has no
-- edit or delete surface. The triggers refuse every UPDATE and DELETE at the engine, the reason
-- `meeting_notes`' trigger (0033) exists — a direct SQL session bypasses the application layers.
DELIMITER $$

CREATE TRIGGER trg_portal_access_log_no_update
BEFORE UPDATE ON portal_access_log FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'portal_access_log rows are immutable';
END$$

CREATE TRIGGER trg_portal_access_log_no_delete
BEFORE DELETE ON portal_access_log FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'portal_access_log rows are append-only';
END$$

DELIMITER ;
