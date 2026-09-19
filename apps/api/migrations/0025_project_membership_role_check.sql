-- 0025_project_membership_role_check — constrain `project_memberships.role` at the database.
--
-- Governing sources: 12-PERMISSION-MATRIX.md §2 (the role set; §1 names the internal
-- principals) and 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md §11 (the role/operation
-- ceiling), with 23-ERD-AND-STATE-MACHINES on column constraints. Recorded open in
-- docs/implementation-status.md (defect 5): `project_memberships.role` was declared in
-- 0001_tenancy.sql as `VARCHAR(64) NOT NULL DEFAULT 'member'` with no constraint, so any
-- string persisted. The TypeScript union (`InternalRole` in packages/domain) already blocks
-- a bad write from the service, but a raw-SQL path or a future caller that bypasses the union
-- could store a typo silently. This is the storage-half guard that closes that gap.
--
-- ## Scope: the INTERNAL role set, not the full union
--
-- `project_memberships` records "which internal people are on which project"
-- (project-memberships.repository.ts). Its `role` column is typed `InternalRole` throughout
-- the service and repository (`AddProjectMemberInput.role`, `changeRole`), never `Role`. The
-- client-side relation is a different table (`client_memberships` / `project_clients`) with
-- its own vocabulary. So the tightest constraint that matches the invariant the code already
-- enforces is the seven INTERNAL_ROLES from packages/domain, not the eleven-name union.
-- Admitting client roles here would be looser than the type the application writes.
--
-- ## CHECK, not ENUM
--
-- The house pattern for a fixed vocabulary elsewhere is `ENUM` (see 0001 status/audience
-- columns). A CHECK is used here instead because it is the surgical change the brief ranks
-- first when the engine enforces it (MySQL 8.0.16+ and MariaDB 10.2+ both do): it constrains
-- the existing `VARCHAR(64)` column in place, with no column-type rewrite and no change to the
-- `InternalRole` type the repository reads back. The value list is derived from the
-- `INTERNAL_ROLES` frozen array in packages/domain; `migrator.db.test.ts` asserts the two do
-- not drift, so this is not a second hand-maintained copy.
--
-- ## Existing data and re-runnability
--
-- Forward-only, applied exactly once by the ledger like its siblings (0023 adds columns with
-- a plain ALTER for the same reason — the migrator never re-executes an applied file). Adding
-- a CHECK constraint validates every existing row: current data holds only internal roles, so
-- it passes; a row with a role outside the set would make this ALTER fail loudly (MySQL error
-- 3819, check constraint violated) rather than silently skip it.

ALTER TABLE project_memberships
  ADD CONSTRAINT chk_project_memberships_role
  CHECK (role IN (
    'owner',
    'org_admin',
    'workspace_admin',
    'manager',
    'moderator',
    'member',
    'guest'
  ));
