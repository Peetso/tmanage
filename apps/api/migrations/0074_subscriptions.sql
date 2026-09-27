-- 0074_subscriptions — the organization's current subscription / plan (Billing module 19, x177).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Billing ("subscription / current
-- plan — view and request a plan change"); 49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY §8 (the
-- billing screen); 07-DATA-MODEL §9 (index prefixes lead with `organization_id`);
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys).
--
-- ## Migration number
--
-- NEXT-SCOPES-13 reserves 0060-0080 in slice-id order; x177's reservation is 0074. The migrator
-- applies files in ascending numeric order and a gap is not an error (it rejects only a NEW file
-- numbered *below* an applied one), so 0074 sits above every predecessor on this slice's base
-- (master bcfe397, highest present 0052) and above the sibling pass-21 reservations not yet
-- integrated. Nothing here depends on the literal 0074 beyond the filename.
--
-- ## What this table is
--
-- One row per organization: its current plan, the plan's status, and when the current period ends.
-- The billing screen reads it (defaulting to the free/base tier when no row exists), and a plan
-- change writes it with `status = 'pending_change'`. That is the whole scope of this slice.
--
-- ## No money moves here
--
-- Real payment, charging and card storage are out of scope (Needs-Peter — an external provider).
-- This table records the *state* of a subscription and the *intent* to change plan; it never
-- carries a card, a charge, or a provider token. A plan change is a recorded request, not a
-- transaction: `status = 'pending_change'` is exactly "the customer asked; nothing has been
-- charged". Activating a change (and any billing it implies) is a later slice with a provider.
--
-- ## One row per organization
--
-- The subscription is a property of the organization, not a log, so the tenant owns exactly one
-- row. `uq_subscriptions_org` (organization_id) makes that true at the engine, and the repository
-- upserts on it: a second change updates the one row rather than appending. The
-- `(organization_id, id)` key every tenant table carries is kept as well, so a future child can
-- reference this row without a cross-tenant path (and the isolation corpus requires it).
--
-- ## Identity is immutable
--
-- `organization_id` is what a subscription belongs to; the `BEFORE UPDATE` trigger pins it at the
-- engine (ADR-0001 layers 3 and 4 are application-side and a direct SQL session bypasses both),
-- the reason every other identity trigger in this schema exists. `plan_id`, `status` and
-- `current_period_end` are left editable — a plan change is exactly an update of those columns —
-- so the runtime credential is granted INSERT and UPDATE (no DELETE): a subscription is created
-- and changed, never removed by a runtime credential.

CREATE TABLE subscriptions (
  id                 CHAR(36)     NOT NULL,
  organization_id    CHAR(36)     NOT NULL,
  -- The plan the organization is on (or, when status is pending_change, the plan it has asked to
  -- move to). A short opaque handle from the plan catalog, validated by the application; the column
  -- stores it as text and never as a taxonomy the database would have to keep in step.
  plan_id            VARCHAR(64)  NOT NULL,
  -- 'active' = this plan is the current one; 'pending_change' = the customer requested this plan
  -- and nothing has been charged or activated. No 'past_due'/'canceled' yet — those belong to the
  -- payment slice (Needs-Peter).
  status             ENUM('active', 'pending_change') NOT NULL DEFAULT 'active',
  -- When the current billing period ends. Null on the free/base tier and until a provider sets it.
  current_period_end DATETIME(3)  NULL,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries.
  UNIQUE KEY uq_subscriptions_org_id (organization_id, id),
  -- One subscription per organization: the upsert target, and what makes "one row per org" true at
  -- the engine rather than by the application remembering to check.
  UNIQUE KEY uq_subscriptions_org (organization_id),
  CONSTRAINT fk_subscriptions_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A subscription's tenant is immutable; its plan, status and period end are the mutable state a
-- plan change writes. `updated_at` is stamped by the application on every write.
DELIMITER $$

CREATE TRIGGER trg_subscriptions_immutable
BEFORE UPDATE ON subscriptions FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'subscriptions.organization_id is immutable';
  END IF;
END$$

DELIMITER ;
