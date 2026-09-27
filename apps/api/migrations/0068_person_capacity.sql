-- 0068_person_capacity — per-member weekly capacity (People module 14, capacity, x170).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §People ("capacity" — a member's
-- available hours a week, the basis staffing and allocation read); 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX
-- §People; 07-DATA-MODEL §9 (index prefixes lead with `organization_id`); 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §6 (composite tenant keys). Audit #4 (People Missing — capacity not built).
--
-- ## Migration number
--
-- NEXT-SCOPES-13 reserves 0060–0080 for pass 21 in slice-id order; x170's reservation is 0068. The
-- migrator applies files in ascending numeric order and a gap is not an error (it rejects only a NEW
-- file numbered below an applied one), so 0068 on this base is correct. If the integration renumbers
-- the reservations, the integrator renumbers this file with them; nothing here depends on the literal
-- 0068 beyond the filename.
--
-- ## What this migration is for
--
-- A member has no recorded *capacity* — how many hours a week they are available. This is the smallest
-- useful unit that adds one: one active row per member, holding the weekly hours and the date the
-- figure takes effect. Allocation (x171) reads against it; this slice only sets and reads the figure.
--
-- ## One active row per member, tenant-scoped
--
-- Capacity belongs to a membership, which belongs to one organization, so the tenant key is
-- `organization_id` and the natural key is `(organization_id, membership_id)` — one active row per
-- member, enforced by a unique key so the PUT is an upsert rather than a growing history. History of
-- past figures is a later slice; this table carries only the current capacity at rest. The membership
-- is bound by the composite FK `(organization_id, membership_id)` so a member of another tenant can
-- never be named — the cross-tenant path the controller turns into a 404.
--
-- ## weekly_hours is bounded at the engine too
--
-- The application validates `weekly_hours` in [0,168] (a week has 168 hours) and refuses out of range
-- with a 400 before any write, but a direct SQL session bypasses the application (ADR-0001 layers 3
-- and 4 are application-side), so the bound is also a CHECK constraint here.
--
-- ## Identity is immutable
--
-- `organization_id` and `membership_id` are what a capacity row is; the `BEFORE UPDATE` trigger holds
-- them at the engine, the reason every other identity trigger in this schema exists. `weekly_hours`,
-- `effective_from` and `updated_at` are left editable — the upsert rewrites them. This slice grants
-- the app INSERT and UPDATE (the upsert), no DELETE: a capacity figure is set and revised, never
-- removed by a runtime credential.

CREATE TABLE person_capacity (
  id              CHAR(36)          NOT NULL,
  organization_id CHAR(36)          NOT NULL,
  membership_id   CHAR(36)          NOT NULL,
  -- Available hours a week. Bounded [0,168] at the engine as well as in the application.
  weekly_hours    SMALLINT UNSIGNED NOT NULL,
  -- The date this figure takes effect. A DATE, not a timestamp: capacity is a per-day plan figure.
  effective_from  DATE              NOT NULL,
  updated_at      DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can reference
  -- this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_person_capacity_org_id (organization_id, id),
  -- One active capacity row per member within a tenant: the natural key the upsert collides on.
  UNIQUE KEY uq_person_capacity_org_membership (organization_id, membership_id),
  CONSTRAINT fk_person_capacity_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The member, bound with organization_id so the reference cannot cross a tenant boundary. The
  -- unique key above is the backing index InnoDB requires for the leftmost referencing columns.
  CONSTRAINT fk_person_capacity_membership
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id),
  CONSTRAINT ck_person_capacity_weekly_hours CHECK (weekly_hours BETWEEN 0 AND 168)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A capacity row's tenant and member are immutable, the reason every identity trigger in this schema
-- gives. `weekly_hours`, `effective_from` and `updated_at` are left editable for the upsert; identity
-- is not.
DELIMITER $$

CREATE TRIGGER trg_person_capacity_immutable
BEFORE UPDATE ON person_capacity FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'person_capacity.organization_id is immutable';
  END IF;
  IF NEW.membership_id <> OLD.membership_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'person_capacity.membership_id is immutable';
  END IF;
END$$

DELIMITER ;
