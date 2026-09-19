-- 0023_membership_scope_and_policy_version — TEN-001 leftovers: a workspace-scope column for
-- Workspace Admins, and a stored policy-version epoch on organizations and memberships.
--
-- Governing sources: 12-PERMISSION-MATRIX.md §2 (Workspace Admin holds "Scope" on View
-- internal project and "Workspace scope" on View audit log — a reach wider than the projects
-- they joined but narrower than the whole organization) and
-- 25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md §2/§9 (the tenant context carries a "policy
-- version" that §9 uses as the cache/decision epoch). Both were recorded open in
-- docs/implementation-status.md (gaps #5 and #6); this migration is the storage half of each.
--
-- The slug-change leftover (gap #4) is NOT here: reserving versus reusing an old slug is a
-- product decision the planning pack does not answer, so it stays open rather than guessed.
--
-- ## Part A — a Workspace Admin's scope is one workspace (gap #5)
--
-- Until now `has_org_wide_scope` was the only scope expression a membership had: a boolean,
-- true for owner/org_admin and false for everyone else. A Workspace Admin with it false falls
-- back to the projects they are personally a member of — narrower than §2 grants them. Setting
-- it true would grant the whole organization — wider than §2 grants them, and the boolean has
-- no room for "within this workspace".
--
-- `workspace_scope_id` is that missing middle: NULL keeps the safe project-membership fallback
-- (no widening for the roles that have it null today), and a workspace id means "every project
-- in this one workspace, and nothing outside it". A single nullable column, not a
-- membership↔workspace join table, mirrors the boolean's one-scope shape; multi-workspace
-- admins are deferred with a divergence recorded in the status doc. The composite foreign key
-- includes `organization_id` (ADR-0001 layer 1), so a membership can only ever be scoped to a
-- workspace of its own tenant — a cross-tenant scope id is refused by the engine, not by a
-- service check.
--
-- ## Part B — the policy version is stored, not derived from updated_at (gap #6)
--
-- The resolver derived the context's policy version from `organizations.updated_at` and
-- `memberships.updated_at`. Both carry `ON UPDATE CURRENT_TIMESTAMP(3)`, so an organization
-- rename or any unrelated write rotated the epoch and invalidated every member's cache key for
-- a change that touched no policy. `policy_version` decouples the epoch from row churn: it
-- moves only when the code that changes a policy-relevant fact bumps it — a membership's on
-- role/scope change, an organization's on a future org-policy write. A rename no longer
-- rotates anything. `BIGINT UNSIGNED` and the same one-per-row default as `version`; it is a
-- monotonic epoch, never decremented.
--
-- No backfill beyond the DEFAULT: every existing row starts at policy version 1, which is the
-- correct epoch for a policy that has not changed since the row was written.

ALTER TABLE memberships
  ADD COLUMN workspace_scope_id CHAR(36) NULL AFTER has_org_wide_scope,
  ADD COLUMN policy_version BIGINT UNSIGNED NOT NULL DEFAULT 1 AFTER version,
  ADD CONSTRAINT fk_memberships_workspace_scope_tenant
    FOREIGN KEY (organization_id, workspace_scope_id)
    REFERENCES workspaces (organization_id, id);

ALTER TABLE organizations
  ADD COLUMN policy_version BIGINT UNSIGNED NOT NULL DEFAULT 1 AFTER timezone;
