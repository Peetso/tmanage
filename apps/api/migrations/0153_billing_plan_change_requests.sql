-- 0153_billing_plan_change_requests — org-scoped plan-change requests (Billing & entitlements,
-- module 19, x284).
--
-- Governing sources: 49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY §plan changes; 38-COMPLETE-PRODUCT-
-- SCOPE-AND-MODULE-MAP §Billing; 22-SCREEN-BY-SCREEN §Billing plan; 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §6 (composite tenant keys); 07-DATA-MODEL §9 (index prefixes lead with organization_id).
--
-- ## Migration number
--
-- Pass 25 reserves 0145–0173 in slice-id order; x284's reservation is 0153 (pass25-queue header map).
-- The highest migration present on this slice's base (origin/master) is 0129; 0130–0152 are reserved
-- by sibling pass-24/25 branches not yet integrated, so 0153 sits above every reservation. The
-- migrator applies files in ascending numeric order and a gap is not an error (it rejects only a NEW
-- file numbered below an applied one), so 0153 on top of 0129 is correct on this base. If the
-- integration renumbers the reservations, the integrator renumbers this file with them; nothing here
-- depends on the literal 0153 beyond the filename.
--
-- ## What this migration is for
--
-- The Billing module shows an organization's current plan but records no intent to move off it. This
-- adds the smallest useful unit for that — an org-scoped **plan-change request**: a `target_plan_code`
-- (validated against the application plan catalog before any write), an `effective_on` date (today or
-- later), an optional `note`, and a `status` (`pending` → `cancelled`). It is a recorded intent, not a
-- charge: nothing here bills, calls a provider, or changes an entitlement (all Needs-Peter). A later
-- payment slice acts on a pending request; this table only records which plan an admin asked to move
-- to and when.
--
-- `target_plan_code` is validated against a fixed application allowlist (`plan-catalog.ts`) before any
-- write, so an off-catalog value is a 400 with no write and the column only ever holds a known plan id.
-- It is stored as a short VARCHAR rather than a MySQL ENUM so the catalog can grow without an
-- ALTER TABLE — the application is the source of truth for the closed set, as `billing_usage_alerts.
-- metric` (0083) is.
--
-- ## Org-scoped, not project-owned
--
-- Like `billing_usage_alerts` (0083) and `org_settings` (0058), a plan-change request belongs to the
-- organization, not a project: billing is an org-admin concern (`org.manage`, owner-only). So there is
-- no `project_id` and no project composite foreign key — the tenant key is `organization_id` alone,
-- bound to `organizations`.
--
-- ## One pending request per organization
--
-- A studio may have at most one open request at a time: a second POST while one is pending is a 409,
-- not a second row. The application checks for an existing pending row inside the create transaction,
-- and `pending_guard` (a stored generated column that is `organization_id` while pending and NULL once
-- cancelled) carries a UNIQUE key so the engine refuses a second pending row even under a race — NULLs
-- do not collide, so any number of cancelled rows coexist.
--
-- ## Identity is immutable; only status is editable
--
-- `organization_id`, `created_by`, `target_plan_code`, `effective_on` and `note` are what a request
-- *is*; the `BEFORE UPDATE` trigger holds them at the engine (ADR-0001 layers 3 and 4 are application-
-- side and a direct SQL session bypasses both). `status` is the one column the cancel path may change,
-- and only `pending` → `cancelled` (never back), so the app is granted INSERT and UPDATE (no DELETE):
-- a request is created and cancelled, never removed by a runtime credential this slice.

CREATE TABLE billing_plan_change_requests (
  id                CHAR(36)      NOT NULL,
  organization_id   CHAR(36)      NOT NULL,
  -- The plan the organization asked to move to. Validated against the application plan catalog
  -- (free/starter/pro/business) before any write; the column only ever holds a known plan id.
  target_plan_code  VARCHAR(64)   NOT NULL,
  -- The date the change should take effect. Bounded today-or-later by the application before the write.
  effective_on      DATE          NOT NULL,
  -- An optional free-text note explaining the request. NULL when omitted.
  note              TEXT          NULL,
  -- Lifecycle: a request is `pending` at creation and moves to `cancelled`. Never back.
  status            ENUM('pending', 'cancelled') NOT NULL DEFAULT 'pending',
  created_by        CHAR(36)      NOT NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- `organization_id` while the request is pending, NULL once cancelled — the one-pending-per-org guard
  -- below keys on it so the engine refuses a second pending row while NULLs (cancelled) never collide.
  pending_guard     CHAR(36) GENERATED ALWAYS AS
    (IF(status = 'pending', organization_id, NULL)) STORED,
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can reference
  -- this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_billing_plan_change_requests_org_id (organization_id, id),
  -- At most one pending request per organization; cancelled rows (pending_guard NULL) do not collide.
  UNIQUE KEY uq_billing_plan_change_requests_pending (pending_guard),
  -- The list index: a studio's requests newest-first. Leads with organization_id per 07-DATA-MODEL §9.
  KEY ix_billing_plan_change_requests_org_created (organization_id, created_at),
  CONSTRAINT fk_billing_plan_change_requests_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The actor. References users (id) without organization_id because a user is not tenant-owned —
  -- the same shape `billing_usage_alerts.created_by` (0083) uses.
  CONSTRAINT fk_billing_plan_change_requests_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A request's tenant, author, target plan, effective date and note are immutable, the reason
-- `billing_usage_alerts`' trigger gives. Only `status` is left editable at the engine for the cancel
-- path (pending → cancelled); identity is not, and status never moves back to pending.
DELIMITER $$

CREATE TRIGGER trg_billing_plan_change_requests_immutable
BEFORE UPDATE ON billing_plan_change_requests FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'billing_plan_change_requests.organization_id is immutable';
  END IF;
  IF NEW.created_by <> OLD.created_by THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'billing_plan_change_requests.created_by is immutable';
  END IF;
  IF NEW.target_plan_code <> OLD.target_plan_code THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'billing_plan_change_requests.target_plan_code is immutable';
  END IF;
  IF NEW.effective_on <> OLD.effective_on THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'billing_plan_change_requests.effective_on is immutable';
  END IF;
  IF NOT (NEW.note <=> OLD.note) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'billing_plan_change_requests.note is immutable';
  END IF;
  IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'billing_plan_change_requests.status cannot leave cancelled';
  END IF;
END$$

DELIMITER ;
