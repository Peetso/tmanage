-- 0143_home_quick_links — a member's own quick links on My Day: a small, ordered list of personal
-- shortcuts (a human label + an in-app path) they add, reorder and remove (module 4 Home / My Day,
-- HOME-05 "Saved/pinned context", x273).
--
-- Governing sources: 38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP §Home / My Day (recent context, quick
-- capture; a per-user quick-links shortcut list did not exist); 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §6 (composite tenant keys); 07-DATA-MODEL §9 (index prefixes lead with organization_id).
-- Distinct from x144 home pins (0050, which pins *objects* — a work item / project / document by id)
-- and x243 home widget prefs (0115, which orders the *fixed* Home widgets): this stores free-form
-- personal shortcuts, each a label and a relative in-app path the member typed.
--
-- ## Migration number
--
-- The pass-24 queue map reserves 0143 for x273. The highest migration present on this slice's base
-- (master 5b3fcf0) is 0115; 0116-0142 are reserved by sibling pass-24 branches not yet integrated.
-- The migrator applies files in ascending numeric order and a gap is not an error (it rejects only a
-- NEW file numbered below an applied one), so 0143 on top of 0115 is correct on this base. If the
-- integration renumbers the reservations, the integrator renumbers this file with them.
--
-- ## One row per link, keyed by membership, ordered by position
--
-- A row is one quick link owned by one membership in one studio, keyed `(organization_id, id)` —
-- tenant-owned like `home_pinned_items` (0050) and `home_widget_prefs` (0115), registered in the
-- query guard's TENANT_TABLES. It is keyed to `membership_id`, not the global `user_id`: a quick
-- link is scoped to who the caller is in this studio and never leaves the tenant, and the composite
-- foreign key binds the row to a membership of this same organization. The route has no path or
-- query that could name another membership — the acting membership comes from the authenticated
-- principal — so a caller reads, adds, reorders and removes their own links and no other's.
--
-- ## label + relative in-app path; ordering is explicit
--
-- `label` is the member's chosen text and `path` is a relative in-app destination. The application
-- (`quick-links.service.ts`) enforces that `path` is a leading-slash, same-origin, scheme-less path
-- (no `http(s)://`, no protocol-relative `//host`, no backslash) — an open-redirect guard — and that
-- `label` is non-empty; a malformed body is a 400 and nothing is written. `position` gives the
-- member's chosen order, reassigned as a dense 0..n-1 sequence on reorder; `created_at` breaks ties
-- for a total, deterministic order. The count is capped in the application (<=20) — a further add is
-- a 409 — so a member's list stays small.
--
-- ## Identity is immutable; the app may INSERT / UPDATE / DELETE
--
-- `organization_id` and `membership_id` are what a row is; the BEFORE UPDATE trigger pins them at the
-- engine. This slice grants the app INSERT (add), UPDATE (reorder — position only in practice) and
-- DELETE (remove); SELECT is the database-wide grant.

CREATE TABLE home_quick_links (
  id                CHAR(36)      NOT NULL,
  organization_id   CHAR(36)      NOT NULL,
  -- The membership whose quick link this row holds. Private to it: every read, the reorder and the
  -- delete are scoped by membership_id = the acting context's membership, so one member never sees
  -- or changes another's links even inside the same tenant. The composite FK below binds it to a
  -- membership of this same organization.
  membership_id     CHAR(36)      NOT NULL,
  -- The member's chosen text for the link.
  label             VARCHAR(200)  NOT NULL,
  -- A relative in-app destination. The application validates it is a leading-slash, scheme-less,
  -- same-origin path (no `http(s)://`, no protocol-relative `//`, no backslash) before storing —
  -- an open-redirect guard — so the column holds only in-app paths.
  path              VARCHAR(512)  NOT NULL,
  -- The member's chosen order, a dense 0..n-1 sequence reassigned on reorder.
  position          INT UNSIGNED  NOT NULL DEFAULT 0,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                  ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries, the target of the composite FKs
  -- that bind child rows within one tenant (and the isolation corpus requires it).
  UNIQUE KEY uq_home_quick_links_org_id (organization_id, id),
  -- The listing/order index: one member's links in position order, id breaking ties.
  KEY ix_home_quick_links_org_membership (organization_id, membership_id, position, id),
  CONSTRAINT fk_home_quick_links_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The membership, bound within its own tenant: the composite key refuses a membership id from
  -- outside this row's organization, so a quick link can never cite a membership in another studio.
  CONSTRAINT fk_home_quick_links_membership_tenant
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A row's tenant and membership are what it is and are immutable; only the label, path, position and
-- updated_at change. The trigger holds identity at the engine, the reason every other identity
-- trigger in this schema exists.
DELIMITER $$

CREATE TRIGGER trg_home_quick_links_immutable
BEFORE UPDATE ON home_quick_links FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'home_quick_links.organization_id is immutable';
  END IF;
  IF NEW.membership_id <> OLD.membership_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'home_quick_links.membership_id is immutable';
  END IF;
END$$

DELIMITER ;
