-- 0200_search_scopes — saved search scopes (Search module, SRCH saved scopes, x334).
--
-- Governing sources: 38-MODULE-MAP §Search, command & AI (saved scopes on top of the SRCH-01 global
-- search x111 and SRCH ranking x148); 22-SCREEN §Search; 25-AUTHORIZATION-AND-TENANT-ISOLATION §6
-- (composite tenant keys, `(organization_id, id)` on every tenant table); 07-DATA-MODEL §9 (index
-- prefixes lead with `organization_id`); ADR-0001 (MySQL has no row-level security; the withheld
-- privilege and the tenant/owner predicates are the control).
--
-- ## Migration number
--
-- Pass 26 reserves 0174-0201 in slice-id order; x334's reservation is 0200 (pass26-queue header map).
-- The migrator applies files in ascending numeric order and a gap is legitimate (it rejects only a
-- NEW file numbered *below* an applied one), so 0200 on this base is correct; nothing here depends on
-- the literal 0200 beyond the filename, and the integrator renumbers with the reservations if they
-- move.
--
-- ## What this is
--
-- A member may run and remember a *query* (`saved_searches`, 0092) and share it (`saved_search_shares`,
-- 0142), but there is no reusable **filter scope** — a named set of pre-filters (which object types,
-- an optional project, an optional date window) that narrows the search before it runs. This is the
-- smallest useful unit that adds one: ONE table carrying a member's named scopes.
--
--   * `name` — the scope's label, required and unique per owner (the application enforces non-empty).
--   * `filters` — a validated, bounded JSON object `{ objectTypes[], projectId?, from?, to? }`. Each
--     `objectType` is one of the search-index kinds (`work_item`, `document`); an off-allowlist kind
--     is a 400 with no write. `projectId`, when given, is resolved tenant-scoped before the write (an
--     unknown or cross-tenant id is a 400). `from`/`to` are optional ISO-date window bounds.
--
-- Distinct from `saved_searches` (a saved query string) and `saved_search_shares` (team sharing):
-- this is a reusable filter scope, applied by returning its filters to the search read — no new query
-- engine, no new ranking.
--
-- Every row is **private to one member in one studio**: every read, the create, the update and the
-- delete are scoped by `organization_id = the acting tenant` AND `member_user_id = the acting user`,
-- so one member never sees or changes another's scopes even inside the same studio, and a
-- cross-tenant or other-member id resolves to nothing (the service answers 404).
--
-- ## Grants and mutability
--
-- The runtime credential is granted INSERT, UPDATE and DELETE: a scope is created (POST), replaced in
-- place (PUT, idempotent), and removed (DELETE 204). The 0200 trigger below pins organization_id and
-- member_user_id immutable for every credential, so the granted UPDATE can change only the name/filters
-- and never move a scope between studios or owners.

CREATE TABLE search_scopes (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NOT NULL,
  -- The owner. References users (id) without organization_id because a user is not tenant-owned —
  -- the shape `saved_searches.user_id` (0092) and `saved_views.owner_user_id` (0034) use.
  member_user_id  CHAR(36)     NOT NULL,
  -- The scope's label. Required and unique per owner (the application enforces non-empty). VARCHAR(300)
  -- matches the name columns the search module ranges over.
  name            VARCHAR(300) NOT NULL,
  -- The filter set, as a validated, bounded JSON object { objectTypes[], projectId?, from?, to? }. The
  -- application validates and bounds it before the write, so the column only ever holds a small,
  -- well-formed object.
  filters         JSON         NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- The (organization_id, id) key every tenant-scoped table carries (25-AUTH §6), so a future child
  -- can reference this row without a cross-tenant path and the isolation corpus is satisfied.
  UNIQUE KEY uq_search_scopes_org_id (organization_id, id),
  -- One owner's scope names are unique within their studio: (organization_id, member_user_id, name).
  -- A repeat name on create/rename is a 409.
  UNIQUE KEY uq_search_scopes_org_member_name (organization_id, member_user_id, name),
  -- The listing index: one owner's scopes, newest first. Leads with `organization_id` per
  -- 07-DATA-MODEL §9, then `member_user_id` (the equality predicate), then `created_at` and `id`.
  KEY ix_search_scopes_org_member (organization_id, member_user_id, created_at, id),
  CONSTRAINT fk_search_scopes_org
    FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_search_scopes_member
    FOREIGN KEY (member_user_id) REFERENCES users (id)
) ENGINE=InnoDB ROW_FORMAT=DYNAMIC DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Immutability: the tenant and owner of a scope are fixed at creation. A granted UPDATE may change the
-- name and filters (the edit endpoint), but never move a scope to another studio or member.
DELIMITER $$
CREATE TRIGGER trg_search_scopes_no_reparent
BEFORE UPDATE ON search_scopes
FOR EACH ROW
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.member_user_id <> OLD.member_user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'search_scopes.organization_id and member_user_id are immutable';
  END IF;
END$$
DELIMITER ;
