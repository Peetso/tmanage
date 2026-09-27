-- 0095_member_reporting_lines — a member's reporting line / manager (People module 14, org chart, x217).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §People & capacity ("reporting lines" —
-- who a member reports to, the edges the org chart draws); 41-WHOLE-APP-SCREEN-AND-STATE-MATRIX §People.
-- Audit (pass 21): the People directory (x168) was built with no reporting-line / manager model.
--
-- ## What this migration is for
--
-- The directory lists people but records no *reporting line* — who a member's manager is. This is the
-- smallest useful unit that adds one: at most one manager per member, so the set of rows is the edge
-- set of the reporting tree the org-chart screen draws. Setting a manager is an upsert; clearing it is
-- a delete; reading the tree is a read of every edge in the tenant.
--
-- ## One manager per member, tenant-scoped
--
-- A reporting line belongs to a membership, which belongs to one organization, so the tenant key is
-- `organization_id` and the natural key is `(organization_id, member_id)` — at most one active row per
-- member, enforced by a unique key so the PUT is an upsert rather than a growing history. Both the
-- member and the manager are bound by composite FKs `(organization_id, …)` to `memberships`, so neither
-- can ever name a member of another tenant — the cross-tenant path the controller turns into a 404.
--
-- ## Self-reference and cycles
--
-- A member cannot be their own manager: a `CHECK` refuses `member_id = manager_member_id` at the engine
-- as well as the 400 the controller returns. A longer cycle (A→B→A) cannot be expressed at the engine
-- cheaply, so the controller is the authority: before a write it walks the proposed manager's chain
-- upward within the tenant, bounded, and refuses (400, no write) if it reaches the member. The engine
-- guarantees only the one-hop self-reference; the application guarantees acyclicity.
--
-- ## Identity is immutable
--
-- `organization_id` and `member_id` are what a reporting-line row *is*; the `BEFORE UPDATE` trigger
-- holds them at the engine, the reason every other identity trigger in this schema exists.
-- `manager_member_id` and `updated_at` are left editable — the upsert rewrites the manager in place.
-- The app is granted INSERT, UPDATE and DELETE: a line is set (INSERT), revised (UPDATE, the upsert)
-- and cleared (DELETE).

CREATE TABLE member_reporting_lines (
  id                CHAR(36)    NOT NULL,
  organization_id   CHAR(36)    NOT NULL,
  -- The member whose reporting line this is.
  member_id         CHAR(36)    NOT NULL,
  -- The member they report to. Never equal to member_id (checked below).
  manager_member_id CHAR(36)    NOT NULL,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, so a future child can reference
  -- this row without a cross-tenant path (and the isolation corpus requires it).
  UNIQUE KEY uq_member_reporting_lines_org_id (organization_id, id),
  -- At most one reporting line per member within a tenant: the natural key the upsert collides on.
  UNIQUE KEY uq_member_reporting_lines_org_member (organization_id, member_id),
  CONSTRAINT fk_member_reporting_lines_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The member, bound with organization_id so the reference cannot cross a tenant boundary. The
  -- unique key above is the backing index InnoDB requires for the leftmost referencing columns.
  CONSTRAINT fk_member_reporting_lines_member
    FOREIGN KEY (organization_id, member_id) REFERENCES memberships (organization_id, id),
  -- The manager, likewise bound within the tenant.
  CONSTRAINT fk_member_reporting_lines_manager
    FOREIGN KEY (organization_id, manager_member_id) REFERENCES memberships (organization_id, id),
  -- A member is never their own manager. The application also returns a 400 before any write; this is
  -- the engine half a direct SQL session cannot bypass. A longer cycle is the controller's job.
  CONSTRAINT ck_member_reporting_lines_not_self CHECK (member_id <> manager_member_id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The backing index for the manager FK's leftmost columns, and the lookup the org-chart read groups by.
CREATE INDEX ix_member_reporting_lines_org_manager
  ON member_reporting_lines (organization_id, manager_member_id);

-- A reporting-line row's tenant and member are immutable, the reason every identity trigger in this
-- schema gives. `manager_member_id` and `updated_at` are left editable for the upsert; identity is not.
DELIMITER $$

CREATE TRIGGER trg_member_reporting_lines_immutable
BEFORE UPDATE ON member_reporting_lines FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'member_reporting_lines.organization_id is immutable';
  END IF;
  IF NEW.member_id <> OLD.member_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'member_reporting_lines.member_id is immutable';
  END IF;
END$$

DELIMITER ;
