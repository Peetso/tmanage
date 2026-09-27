-- 0083_billing_usage_alerts — org-scoped usage-alert threshold rules (Billing & entitlements,
-- module 19, x200).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Billing ("usage/quota"); 25-
-- AUTHORIZATION-AND-TENANT-ISOLATION §6 (composite tenant keys); 07-DATA-MODEL §9 (index prefixes
-- lead with `organization_id`); 49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY §8 (usage thresholds).
--
-- ## Migration number
--
-- Pass 22 reserves 0081–0093 in slice-id order; x200's reservation is 0083 (NEXT-SCOPES-14 header).
-- The highest migration present on this slice's base (origin/master) is 0067; 0068–0082 are reserved
-- by sibling pass-21/pass-22 branches not yet integrated, so 0083 sits above every reservation. The
-- migrator applies files in ascending numeric order and a gap is not an error (it rejects only a NEW
-- file numbered *below* an applied one), so 0083 on top of 0067 is correct on this base. If the
-- integration renumbers the reservations, the integrator renumbers this file with them; nothing here
-- depends on the literal 0083 beyond the filename.
--
-- ## What this migration is for
--
-- The Billing module reads usage/quota but lets no admin set an alert threshold. This adds the
-- smallest useful unit for that — an **org-scoped usage-alert rule**: a `metric` (seats/storage/api),
-- a `threshold_percent` (1–100), and whether the rule is `active`. It is a *rule at rest*, not a
-- dispatcher: nothing here sends an email or notification when a threshold is crossed (delivery is
-- Needs-Peter). The read side that flags which rules are currently breached computes over the existing
-- `usage_counters` bands; this table only records the thresholds an admin chose.
--
-- `metric` is validated against a fixed application allowlist (`usage-alerts.controller.ts`) before any
-- write, so an off-list value is a 400 with no write and the column only ever holds a known token. It
-- is stored as a short `VARCHAR` rather than a MySQL `ENUM` so the allowlist can grow without an
-- `ALTER TABLE`; the application is the source of truth for the closed set, the division
-- `workflow_templates.trigger_kind` (0063) uses.
--
-- ## Org-scoped, not project-owned
--
-- Like `workflow_templates` (0063) and `org_settings` (0058), a usage-alert rule belongs to the
-- organization, not a project: billing is an org-admin concern (`org.manage`). So there is no
-- `project_id` and no project composite foreign key — the tenant key is `organization_id` alone,
-- bound to `organizations`. One rule per metric per organization (`uq_billing_usage_alerts_org_metric`).
--
-- ## Identity is immutable; threshold and active are editable
--
-- `organization_id`, `created_by` and `metric` are what a rule *is*; the `BEFORE UPDATE` trigger holds
-- them at the engine (ADR-0001 layers 3 and 4 are application-side and a direct SQL session bypasses
-- both). `threshold_percent` and `active` are the two columns the update path may change, so the app is
-- granted INSERT and UPDATE (no DELETE): a rule is created and tuned, never removed by a runtime
-- credential this slice.

CREATE TABLE billing_usage_alerts (
  id                CHAR(36)          NOT NULL,
  organization_id   CHAR(36)          NOT NULL,
  -- The metered dimension this rule watches. Validated against a fixed application allowlist
  -- (seats/storage/api) before any write; the column only ever holds a known token.
  metric            VARCHAR(32)       NOT NULL,
  -- The percent-of-quota at or above which the rule is considered breached. Bounded 1–100 by the
  -- application before the write; stored as a small unsigned integer.
  threshold_percent SMALLINT UNSIGNED NOT NULL,
  -- Whether the rule is evaluated. Editable via the update path (with `threshold_percent`).
  active            BOOLEAN           NOT NULL DEFAULT TRUE,
  created_by        CHAR(36)          NOT NULL,
  created_at        DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                      ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can reference
  -- this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_billing_usage_alerts_org_id (organization_id, id),
  -- One rule per metric per organization: a second rule for the same metric is a conflict, not a
  -- second row. Leads with `organization_id` per 07-DATA-MODEL §9 and is the list/lookup index.
  UNIQUE KEY uq_billing_usage_alerts_org_metric (organization_id, metric),
  CONSTRAINT fk_billing_usage_alerts_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The actor. References users (id) without organization_id because a user is not tenant-owned —
  -- the same shape `workflow_templates.created_by` (0063) uses.
  CONSTRAINT fk_billing_usage_alerts_created_by
    FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT chk_billing_usage_alerts_threshold
    CHECK (threshold_percent BETWEEN 1 AND 100)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A rule's tenant, author and metric are immutable, the reason `workflow_templates`' trigger gives.
-- `threshold_percent` and `active` are left editable at the engine for the update path; identity is not.
DELIMITER $$

CREATE TRIGGER trg_billing_usage_alerts_immutable
BEFORE UPDATE ON billing_usage_alerts FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'billing_usage_alerts.organization_id is immutable';
  END IF;
  IF NEW.created_by <> OLD.created_by THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'billing_usage_alerts.created_by is immutable';
  END IF;
  IF NEW.metric <> OLD.metric THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'billing_usage_alerts.metric is immutable';
  END IF;
END$$

DELIMITER ;
