-- 0075_billing_seats — Billing module 19: seat assignment / reclaim (x178).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Billing ("seat management"),
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md §5-6 (scoped writes, composite (organization_id,
-- id) foreign keys), 07-DATA-MODEL.md §9 (every composite index begins with organization_id),
-- ADR-0001 (MySQL has no row-level security; layers 3-5 replace it).
--
-- ## Migration numbering
--
-- Numbered 0075 as reserved by NEXT-SCOPES-13 (pass 21 reserves 0060-0080 in slice-id order; x178
-- is 0075). The highest migration on this slice's base (master bcfe397) is 0052 — 0053-0074 are
-- reserved by sibling pass-20/pass-21 branches not yet integrated here. The migrator applies files
-- in ascending numeric order and a gap is legitimate (migrator.db.test treats versions as a set,
-- not positions), so 0075 on this base is correct; the integrator renumbers only if a collision
-- appears after the merges.
--
-- ## What this is
--
-- A billing seat is a licence a membership holds against the organization's plan. Seat management
-- is the audit's "Billing Partial — seat mgmt not built" gap: assign a seat to a membership, list
-- the active seats and their count, and reclaim (release) a seat. This table carries exactly that —
-- who holds a seat, when it was granted, and when (if ever) it was released.
--
-- Enforcement of a seat *ceiling* against a paid plan is deliberately NOT here (Needs-Peter: real
-- charging / card storage is out of scope). This slice moves no money and counts against no paid
-- limit; it records the assignment fact only.
--
-- ## A seat belongs to a membership of this tenant
--
-- `membership_id` is bound by a composite foreign key including `organization_id`, so a seat can
-- only ever name a membership of its own organization — a cross-tenant `membership_id` is a
-- foreign-key violation the service turns into a 404 by resolving the membership tenant-scoped
-- before the write, never a stored dangling reference.
--
-- ## Release is a soft close, not a delete
--
-- Reclaiming a seat sets `released_at`; the row stays. The history of who held a seat and when is
-- the point of the table, so the app is granted INSERT and UPDATE and never DELETE — the withheld
-- privilege is the control. A membership may hold a new seat after an old one is released, so a
-- second active seat for the same membership is prevented in the application (a single active seat
-- per membership), not by a unique key that a released row would collide with.

CREATE TABLE billing_seats (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The membership this seat is assigned to. Bound to a membership of the same tenant by the
  -- composite foreign key below.
  membership_id   CHAR(36)     NOT NULL,
  -- When the seat was granted. Immutable once set (the trigger pins it).
  assigned_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- When the seat was reclaimed, or NULL while it is active. The one column an UPDATE may move.
  released_at     DATETIME(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can
  -- reference this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_billing_seats_org_id (organization_id, id),
  -- 07-DATA-MODEL §9: the reads that exist — a tenant's seats for a membership (the active-seat
  -- lookup) and, leading with organization_id, the active-seat roster. Leads with organization_id.
  KEY ix_billing_seats_org_membership (organization_id, membership_id, released_at, id),
  CONSTRAINT fk_billing_seats_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A seat's tenant, membership and grant time are what it is; only `released_at` may move. The
-- BEFORE UPDATE trigger pins the three at the engine (ADR-0001 layers 3-4 are application-side and a
-- direct SQL session bypasses both), the reason every other identity trigger in this schema exists.
DELIMITER $$

CREATE TRIGGER trg_billing_seats_immutable
BEFORE UPDATE ON billing_seats FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'billing_seats.organization_id is immutable';
  END IF;
  IF NEW.membership_id <> OLD.membership_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'billing_seats.membership_id is immutable';
  END IF;
  IF NEW.assigned_at <> OLD.assigned_at THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'billing_seats.assigned_at is immutable';
  END IF;
END$$

DELIMITER ;
