-- 0196_admin_security_alerts — admin security-event alert configuration (Administration, security
-- monitoring, x329).
--
-- Governing sources: 38-MODULE-MAP §Administration (security monitoring); 04-SECURITY-PRIVACY
-- §Alerting; 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys); 07-DATA-MODEL §9
-- (index prefixes lead with `organization_id`); ADR-0001 (MySQL has no row-level security; a
-- `BEFORE UPDATE` trigger holds identity at the engine where a direct SQL session would bypass the
-- application layers).
--
-- ## Migration number
--
-- Pass 26 reserves 0174-0201 in slice-id order; x329's reservation is 0196 (pass-26 queue header
-- map). The migrator applies files in ascending numeric order and a legitimate gap is allowed (it
-- rejects only a NEW file numbered *below* an applied one), so 0196 on this base (master after pass
-- 25) is correct; nothing here depends on the literal 0196 beyond the filename, and the integrator
-- renumbers with the reservations if they move.
--
-- ## What this is
--
-- A security admin turns an in-app alert on or off per security event-type key: one row per
-- (organization, event_type_key) records that the tenant wants that event type surfaced. This slice
-- **stores** the configuration and matches it read-only against the tenant's own recent
-- `audit_events`; it dispatches nothing (no email/SMS — Needs-Peter). The read-side preview joins
-- `audit_events` alone, never `authentication_events`: that table is the pre-tenant security log with
-- no `organization_id`, so surfacing its rows per organization could not be tenant-scoped. The keys
-- are validated against a fixed allowlist in the application (`security-alerts.service.ts`), so an
-- off-allowlist key never reaches this table.
--
-- ## One row per (organization, event_type_key); toggled, never rewritten
--
-- `uq_admin_security_alerts_org_event` makes a repeated PUT for the same key an upsert target rather
-- than a second row: the controller's INSERT … ON DUPLICATE KEY UPDATE flips `enabled` in place. The
-- runtime credential holds INSERT and UPDATE (the upsert) and DELETE (removing a key's config), and
-- no database-wide write — reading is the database-wide SELECT.
--
-- ## Identity is immutable
--
-- `organization_id`, `id` and `event_type_key` are what a config row *is*; the `BEFORE UPDATE`
-- trigger holds them at the engine (the reason every other identity trigger in this schema exists).
-- Only `enabled` moves on an upsert; `created_by`/`created_at` record the first write and are left in
-- place.

CREATE TABLE admin_security_alerts (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The security event-type key this row configures. Validated against a fixed allowlist by the
  -- application before any write reaches here, so this column only ever holds a known key.
  event_type_key  VARCHAR(190) NOT NULL,
  -- Whether an in-app alert is raised for this event type. TINYINT(1) is MySQL's boolean. A repeated
  -- PUT flips this in place; DELETE removes the row entirely.
  enabled         TINYINT(1)   NOT NULL DEFAULT 1,
  -- The user who first configured this key. References users (id) without organization_id because a
  -- user is not tenant-owned — the shape `security_settings.updated_by` (0073) uses for its actor.
  created_by      CHAR(36)     NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can reference
  -- this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_admin_security_alerts_org_id (organization_id, id),
  -- Exactly one config row per (organization, event_type_key): the upsert target. A repeated PUT for
  -- the same key overwrites `enabled` in place rather than inserting a second row.
  UNIQUE KEY uq_admin_security_alerts_org_event (organization_id, event_type_key),
  CONSTRAINT fk_admin_security_alerts_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_admin_security_alerts_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A config row's tenant, identity and event-type key are immutable; only `enabled` moves on an
-- upsert. The trigger holds identity at the engine, the reason `security_settings`' (0073) gives.
DELIMITER $$

CREATE TRIGGER trg_admin_security_alerts_immutable
BEFORE UPDATE ON admin_security_alerts FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'admin_security_alerts.organization_id is immutable';
  END IF;
  IF NEW.id <> OLD.id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'admin_security_alerts.id is immutable';
  END IF;
  IF NEW.event_type_key <> OLD.event_type_key THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'admin_security_alerts.event_type_key is immutable';
  END IF;
END$$

DELIMITER ;
