-- 0150_billing_cost_centers — org-scoped billing cost centers and their project assignments
-- (Billing & entitlements, module 19, x281).
--
-- Governing sources: 49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY §allocation; 38-COMPLETE-PRODUCT-
-- SCOPE-AND-MODULE-MAP §Billing; 22-SCREEN-INVENTORY §Billing; 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §6 (composite tenant keys); 07-DATA-MODEL §9 (index prefixes lead with
-- `organization_id`).
--
-- ## Migration number
--
-- Pass 25 reserves 0145–0173 in slice-id order; x281's reservation is 0150 (pass25-queue map). The
-- migrator applies files in ascending numeric order and a gap is not an error, so 0150 on top of the
-- base is correct. If the integration renumbers the reservations, the integrator renumbers this file
-- with them; nothing here depends on the literal 0150 beyond the filename.
--
-- ## What this migration is for
--
-- A billing admin can name **cost centers** (a `code` and a display `name`) and assign projects to
-- them, so usage/spend can later be grouped by cost center. This is *definitions + assignments only* —
-- it stores no amount, meters nothing and charges nothing (allocation reporting is a later slice).
--
-- ## One table, two row kinds
--
-- Both a cost-center *definition* and a project *assignment* live in this one table, discriminated by
-- `row_kind`:
--
--   * a `def` row carries the display `name` and has no `project_id`; it defines the cost center for a
--     `code`. At most one `def` per `(organization_id, code)`.
--   * an `assignment` row shares the `def`'s `code`, carries the `project_id`, and has no `name`. At
--     most one `assignment` per `(organization_id, code, project_id)` — so re-assigning the same
--     project is idempotent, not a second row.
--
-- MySQL has no partial unique index, so "one def per (org, code)" is enforced through a
-- trigger-maintained column `def_code` that is the `code` for a `def` row and `NULL` otherwise, unique with
-- `organization_id`. Assignment rows contribute `NULL` there (distinct under a unique index, so they
-- never collide) and are constrained instead by `uq_billing_cost_centers_assignment`. This is the same
-- technique `work_blockers.active_item` (0011) uses for a one-active-per-tenant rule.
--
-- ## Org-scoped, insert/delete only
--
-- Like `billing_usage_alerts` (0083), a cost center belongs to the organization, not a project: billing
-- is an org-admin concern (`org.manage`). The tenant key is `organization_id`, bound to
-- `organizations`; an `assignment`'s `project_id` is bound to `projects` through the composite
-- `(organization_id, project_id)` key so a project can never be borrowed across tenants (a `def` row's
-- `NULL` project_id satisfies the constraint vacuously). No column is ever updated in place — a cost
-- center is created, assigned to, unassigned from, and deleted — so the runtime credential is granted
-- INSERT and DELETE (and SELECT), never UPDATE, and no immutability trigger is needed.

CREATE TABLE billing_cost_centers (
  id                CHAR(36)                  NOT NULL,
  organization_id   CHAR(36)                  NOT NULL,
  -- Discriminates a cost-center definition from a project assignment. A fixed two-value set, so a
  -- MySQL ENUM rather than an application allowlist.
  row_kind          ENUM('def','assignment')  NOT NULL,
  -- The cost-center code, shared by a def and its assignments. Validated non-empty by the application
  -- before any write.
  code              VARCHAR(64)               NOT NULL,
  -- The display name. Present on a `def` row; NULL on an `assignment` row.
  name              VARCHAR(190)                  NULL,
  -- The assigned project. Present on an `assignment` row; NULL on a `def` row.
  project_id        CHAR(36)                      NULL,
  created_at        DATETIME(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- Engine-maintained by triggers trg_billing_cost_centers_def_code_ins/_upd: the code for a `def`
  -- row, NULL otherwise. Makes "one def per (org, code)" expressible as an ordinary unique index
  -- (MySQL has no partial index). A plain column rather than a generated one so the file runs on
  -- MySQL 8 and MariaDB 10.6+. Never written by the app.
  def_code          VARCHAR(64)                   NULL,
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries.
  UNIQUE KEY uq_billing_cost_centers_org_id (organization_id, id),
  -- One definition per code per organization. Only `def` rows populate `def_code`.
  UNIQUE KEY uq_billing_cost_centers_def (organization_id, def_code),
  -- One assignment per (code, project) per organization; makes a repeat assignment idempotent. Def
  -- rows carry a NULL project_id (distinct under a unique index) and never collide here.
  UNIQUE KEY uq_billing_cost_centers_assignment (organization_id, code, project_id),
  -- The lookup index for an assignment's siblings by code, leading with organization_id (07 §9).
  KEY ix_billing_cost_centers_org_code (organization_id, code),
  CONSTRAINT fk_billing_cost_centers_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- Tenant-safe project reference: the composite key forbids borrowing a project across tenants. A
  -- NULL project_id (every `def` row) satisfies the constraint without a referenced row.
  CONSTRAINT fk_billing_cost_centers_project
    FOREIGN KEY (organization_id, project_id) REFERENCES projects (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Keep `def_code` in step with `row_kind`/`code` on every write (see the column comment above).
DELIMITER $$

CREATE TRIGGER trg_billing_cost_centers_def_code_ins
BEFORE INSERT ON billing_cost_centers FOR EACH ROW
BEGIN
  SET NEW.def_code = CASE WHEN NEW.row_kind = 'def' THEN NEW.code ELSE NULL END;
END$$

CREATE TRIGGER trg_billing_cost_centers_def_code_upd
BEFORE UPDATE ON billing_cost_centers FOR EACH ROW
BEGIN
  SET NEW.def_code = CASE WHEN NEW.row_kind = 'def' THEN NEW.code ELSE NULL END;
END$$

DELIMITER ;
