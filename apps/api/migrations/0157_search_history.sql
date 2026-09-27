-- 0157_search_history — per-member recent search history (Search module 16, x288).
--
-- Governing sources: 22-SCREEN SR (search) — a "recent" list under the search box; 38-MODULE-MAP
-- §Search (recent searches on top of the SRCH-01 global search x111 and the search index 0054);
-- 07-DATA-MODEL §9 (index prefixes lead with `organization_id`); 25-AUTHORIZATION-AND-TENANT-
-- ISOLATION §6 (composite tenant keys, `(organization_id, id)` on every tenant table); ADR-0001
-- (MySQL has no row-level security; the withheld privilege and the tenant/owner predicates are the
-- control).
--
-- ## Migration number
--
-- Pass 25 reserves 0145-0173 in slice-id order; x288's reservation is 0157 (pass25-queue header
-- migration map). The highest migration present on this slice's base (origin/master after pass 24)
-- is lower — the sibling pass-25 branches land the intervening numbers from branches not yet
-- integrated here. The migrator applies files in ascending numeric order and a gap is legitimate (it
-- rejects only a NEW file numbered *below* an applied one), so 0157 on this base is correct; nothing
-- here depends on the literal 0157 beyond the filename, and the integrator renumbers with the
-- reservations if they move.
--
-- ## What this is
--
-- The search box can run a query but cannot offer the member the queries they just ran. This is the
-- smallest useful unit that records them: each successful search records its normalised query, the
-- member reads their most-recent 20 (newest first) to seed a "recent" dropdown, and can clear the
-- whole list.
--
-- ## Tenant-scoped, membership-owned
--
-- A recent query belongs to a `memberships` row, and a membership belongs to an organization, so the
-- tenant key is `organization_id` and the owner key is `membership_id`. The composite FK to
-- `memberships (organization_id, id)` keeps a row inside its member's own tenant — a row can never
-- point at a membership in another organization. Every read, the clear and the retention prune are
-- scoped by `organization_id = the acting tenant` AND `membership_id = the acting member`, so one
-- member never sees or clears another's history even inside the same studio, and a cross-tenant read
-- resolves to nothing. Deleting the member takes their history with them (`ON DELETE CASCADE`).
--
-- ## One row per (member, normalised query)
--
-- Re-running the same query is not a second entry: `(organization_id, membership_id, query)` is
-- UNIQUE, and a repeat refreshes `created_at` (an `INSERT … ON DUPLICATE KEY UPDATE created_at`)
-- rather than adding a duplicate row, so the list is de-duplicated and the repeat moves to the front.
-- The application normalises the query (trim + single-space) and caps its length before the write.
--
-- ## Grants and immutability
--
-- The runtime credential is granted INSERT, UPDATE and DELETE (SELECT is database-wide): INSERT and
-- the dedupe UPDATE record a query, DELETE clears the list and prunes to the retention cap. The
-- `BEFORE UPDATE` trigger holds identity (`organization_id`, `membership_id`, `query`) immutable at
-- the engine — the only legitimate UPDATE is `created_at` (the dedupe refresh), so any attempt to
-- move a row to another member or rewrite its query is refused even from a direct SQL session
-- (ADR-0001 layers 3 and 4 are application-side and a direct session bypasses both).

CREATE TABLE search_history (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The member this history belongs to. Composite FK to `memberships (organization_id, id)` keeps it
  -- in the member's own tenant.
  membership_id   CHAR(36)     NOT NULL,
  -- The normalised query the member ran. VARCHAR(300) matches the bound the SRCH-01 controller
  -- enforces on `q` (the title columns search ranges over are VARCHAR(300)). The application trims,
  -- single-spaces and length-caps it before insert; a blank query is a 400 and never reaches here.
  query           VARCHAR(300) NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries (25-AUTH §6), so a future child
  -- can reference this row without a cross-tenant path and the isolation corpus is satisfied.
  UNIQUE KEY uq_search_history_org_id (organization_id, id),
  -- One row per (member, normalised query): a repeat refreshes `created_at` rather than adding a
  -- second row (the INSERT … ON DUPLICATE KEY UPDATE target). Leads with `organization_id` then
  -- `membership_id` per 07-DATA-MODEL §9.
  UNIQUE KEY uq_search_history_member_query (organization_id, membership_id, query),
  -- The listing/prune index: one member's rows newest first. Leads with `organization_id` then
  -- `membership_id` (the equality predicates), then `created_at` and `id` (the order). Serves the
  -- recent list and the retention prune.
  KEY ix_search_history_member_recent (organization_id, membership_id, created_at, id),
  CONSTRAINT fk_search_history_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  -- The owning member, in the same tenant. Deleting the member removes their history.
  CONSTRAINT fk_search_history_member
    FOREIGN KEY (organization_id, membership_id) REFERENCES memberships (organization_id, id)
    ON DELETE CASCADE
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A history row's tenant, member and query are what it *is* — the only legitimate UPDATE is the
-- dedupe `created_at` refresh. Identity is held immutable at the engine so a direct SQL session
-- cannot move a row to another member or rewrite its query.
DELIMITER $$

CREATE TRIGGER trg_search_history_immutable
BEFORE UPDATE ON search_history FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'search_history.organization_id is immutable';
  END IF;
  IF NEW.membership_id <> OLD.membership_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'search_history.membership_id is immutable';
  END IF;
  IF NEW.query <> OLD.query THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'search_history.query is immutable';
  END IF;
END$$

DELIMITER ;
