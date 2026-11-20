---
part: api/tenancy
kind: api-module
context: tenancy-and-people
owner: implementation-lead
lifecycle: production
depends_on: [api-common/database, api/identity, api/audit, api/platform, package/domain]
provides_api:
  - '/v1/organizations'
  - '/v1/organizations/:orgSlug'
  - '/v1/organizations/:orgSlug/members/*'
  - '/v1/organizations/:orgSlug/admin/members/bulk-role'
  - '/v1/organizations/:orgSlug/admin/roles/built-in'
  - '/v1/organizations/:orgSlug/people/:membershipId/permissions/overrides'
  - '/v1/organizations/:orgSlug/people/:membershipId/effective-permissions'
  - '/v1/organizations/:orgSlug/me'
  - '/v1/organizations/:orgSlug/invitations/*'
  - '/v1/invitations/{previews,acceptances,registrations}'
  - '/v1/organizations/:orgSlug/settings/*'
  - '/v1/organizations/:orgSlug/workspaces'
  - '/v1/organizations/:orgSlug/{client-file-policy,file-download-policy,security/file-safety}'
  - '/v1/organizations/:orgSlug/logo/*'
consumes_api: []
tables_owned:
  [
    organizations,
    memberships,
    workspaces,
    invitations,
    invitation_projects,
    invitation_pending_keys,
    org_settings,
    custom_roles,
    membership_permission_overrides,
    organization_logos,
  ]
rules:
  [
    SE-1,
    AR-5,
    AR-7,
    AR-8,
    AR-9,
    AR-12,
    DA-1,
    DA-2,
    DA-6,
    DA-11,
    DA-12,
    HT-1,
    HT-4,
    QM-2,
    PR-1,
    PR-3,
  ]
ux_rules: []
last_verified_commit: 3b7e4fa70eb6facff3f1dccc65c0867f0707a0a6
last_verified_date: 2026-11-20
last_verified_by: Claude Opus 5.5 (lane E)
---

# api/tenancy

## Purpose and bounded context

Tenancy answers three questions for every org-scoped request: **which organization is this, is the caller a live member of it, and with which role/scope/overrides** (the `Principal`). It also owns the life of an organization (create, profile, logo, lifecycle switches), of a membership (role change, bulk role, overrides, offboarding, member password reset) and of an invitation (issue, reissue, revoke, expire, preview, accept, register).

- Context: **Tenancy & People** (VIEWS §4). It is part of the **shared kernel** with Identity, Audit and Platform outbox: every other context depends on it (VIEWS §4 "tenancy 151 imports").
- Upstream: `api/identity` (the session that the resolver tests the membership against; `PasswordResetService` for member resets, `tenancy.module.ts:181-186`), `package/domain` (roles, capabilities, `authorize()`), `api-common/database` (`TenantDatabase`, the tenant guard).
- Downstream: everything org-scoped. The `TenantContextGuard` (`apps/api/src/common/http/guards/tenant-context.guard.ts`) calls this module's `MembershipResolver` to build the `TenantContext` every repository receives.
- Published services (module exports, `tenancy.module.ts:204-212`): `resolver`, `principals`, `directory`, `provisioning`, `workspaces`, `membershipsRepository`, `invitationsService`. Note that one export is a **repository** (see §11, AR-5).

## Domain model and invariants

Entities: **Organization** (slug, lifecycle: active / suspended / deleted-until-purge), **Membership** (`role`, `status ∈ invited|active|suspended|offboarded`, `version`, `policy_version`, org-wide or workspace scope), **Workspace**, **Invitation** (token hash, role, projects, note), **Custom role**, **Permission override** (allow/deny one capability, optional expiry, revocable, never deleted), **Org setting** (allowlisted key/value).

Value sets come from `@tmanage/domain`: `INTERNAL_ROLES` (`packages/domain/src/policies/capabilities.ts:162`), `PLATFORM_SUPPORT_ROLE` (`:181`), `ASSIGNABLE_INTERNAL_ROLES` (`:190`), `CAPABILITIES` (`:19`).

| # | Invariant (checkable) | Where enforced | Proof |
| --- | --- | --- | --- |
| T-1 | An outsider cannot tell "no such organization" from "not a member": every resolution failure is the same 404 body; only the audit event carries the cause. | `membership-resolver.repository.ts:130-156` (codes), `:178` `MembershipNotResolvedError`; guard maps to 404 `tenant-context.guard.ts:229` | `membership-resolver.db.test.ts`; `apps/api/test/tenant-isolation.db.test.ts` |
| T-2 | A proved member of a suspended organization gets 403 with `SUSPENDED_MESSAGE`; only after the membership matched. | `membership-resolver.repository.ts:158`; guard `tenant-context.guard.ts:224-227` | `membership-resolver.repository.test.ts:295` (deleted org), `plat-015-org-lifecycle.db.test.ts` |
| T-3 | A stopped staff member loses an older client row in the same company (`staff_access_stopped`). | `membership-resolver.repository.ts:143-148` | `wave11-q4-suspended-staff-client.test.ts:142,303` |
| T-4 | The hidden `platform_support` role is never assignable from an org route and never appears in a roster. | `role-grant-ceiling.ts:55` (`ROLE_ASSIGNERS` filter), domain `capabilities.ts:168-178` | `platform-support-exclusion.test.ts:68`; `membership-resolver.repository.test.ts:244` |
| T-5 | **No escalation:** a caller can grant only a role / allow-override whose capabilities they hold. | `role-grant-ceiling.ts:96` `requireMayGrantRole`, `:187` `exceedsCaller`; `override-ceiling.ts:113` `requireMayOverride` | `member-role.controller.test.ts:236`; `membership-overrides.controller.test.ts:237`; `sec-011-role-escalation.db.test.ts` |
| T-6 | Only an owner may give or invite the Owner role. | `member-role.controller.ts` owner-seat branch (`:238-242`); invitations service | `member-role.controller.test.ts:165,248`; `invitations.service.test.ts:352` |
| T-7 | **At least one active owner remains** after a role change, bulk role change or offboarding. | `member-role.controller.ts:244-257` (count other owners → 409), `member-bulk-role.controller.ts:216`, `offboarding.service.ts:285-286` | `member-role.controller.test.ts:135`; `offboarding.controller.test.ts:375`. **Not race-safe, see §11 TEN-D1** |
| T-8 | A role or scope change bumps `version` (optimistic concurrency) and `policy_version` (authorization epoch that rotates cached contexts). | `memberships.repository.ts:395-404`; resolver `policyVersionOf` `membership-resolver.repository.ts:218` | `member-role.controller.test.ts:150` (409 stale version); `scope-and-policy-version.test.ts` |
| T-9 | Overrides are never deleted: a change revokes (`revoked_at`) and inserts, and bumps `policy_version`. At most 112 per member, reason ≤ 500. Owners have no overrides (400). | `membership-overrides.repository.ts:19,211`; `override-ceiling.ts:47,50,53,65` | `override-ceiling.test.ts:42,110`; `membership-overrides.controller.test.ts:174,217`; `perm-001-membership-overrides.db.test.ts` |
| T-10 | One open invitation per (organization, normalized e-mail). | `UNIQUE uq_ipk_email` `0319_invitation_pending_keys.sql:35`, inserted in the same transaction (`:11`); `requireNoOpenInvitation` | `b11-duplicate-invitation.test.ts:8`; `ten-003-invitations.db.test.ts` |
| T-11 | An unknown, used, revoked, expired or malformed invitation token gets one 404; only the hash is stored. | `uq_invitations_token (token_hash)` `0005_invitations.sql:74` | `invitations.service.test.ts:268,275,337` |
| T-12 | A "What members can do" switch only **narrows** the capability ceiling; admins are never narrowed. | `org-policy.ts:18-32` (`ADMIN_ROLES`, `STILL_ALLOWED`), `:50` `requireOrgPermission` | `org-settings.allowlist.test.ts`, `org-settings.controller.test.ts` |

Domain state machines `invitationStateMachine` and `offboardingStateMachine` exist in `packages/domain/src/state-machines/{invitation,offboarding}.ts` but **no file in `apps/` uses them** (grep, 0 hits). The invitation and offboarding states are decided inside this module's services instead (see §11 TEN-D5).

## Public API and contracts

All routes pass the global guard chain (§5). Capabilities are from `@RequireCapability`. Error envelope and status meanings follow ENGINEERING-STANDARD §4 (HT-1).

| Method + path (prefix `v1/organizations/:orgSlug` unless absolute) | Capability | Success | Declared in |
| --- | --- | --- | --- |
| GET `/v1/organizations/address-availability` | session | 200 | `organizations.controller.ts:131` |
| GET `/v1/organizations` (my orgs) · POST `/v1/organizations` (create) | session | 200/201 | `organizations.controller.ts:161,244-246` |
| GET `…/support-session` | `approval.read` | 200 | `organizations.controller.ts:299-300` |
| GET `…/profile` · PATCH `…` · PUT/DELETE `…/logo` | `org.manage` | 200 | `organizations.controller.ts:325-412` |
| GET `…/logo`, `…/logo/image` · PUT/DELETE `…/logo/image` | `work.read`/`org.manage` | 200 | `organization-logo.controller.ts:132-199` |
| GET `…/workspaces` | `work.read` | 200 | `workspaces.controller.ts:44-45` |
| GET `…/members` | `work.read` | 200 | `members.controller.ts:97-98` |
| PATCH `…/members/:userId/role` | `org.manage` | 200; 400 role, 403 owner-only/escalation, 404 user, 409 last owner or stale version | `member-role.controller.ts:162-163`, `:159` |
| GET `…/admin/roles/built-in` | `org.manage` | 200 | `member-role.controller.ts:131-132` |
| POST `…/admin/members/bulk-role` | `org.manage` | 200 | `member-bulk-role.controller.ts:111-112` |
| POST `…/members/:membershipId/password-reset` | `org.manage` | **202** | `member-password-reset.controller.ts:70-72` |
| GET `…/members/:userId/offboarding-impact` · POST `…/offboard` | `member.offboard` | 200 | `offboarding.controller.ts:38-60` |
| GET `…/me` | `approval.read` | 200 | `membership-overrides.controller.ts:149-150` |
| GET/PUT `…/people/:membershipId/permissions/overrides` | `roles.assign` (`ROLE_ASSIGN_CAPABILITY`, `role-grant-ceiling.ts:38`) | 200; 404 other org, 403, 400 owner | `membership-overrides.controller.ts:167-193` |
| GET `…/people/:membershipId/effective-permissions` | `people.view` | 200 | `membership-overrides.controller.ts:264-265` |
| GET/POST `…/invitations` · POST `…/:id/reissues` · DELETE `…/:id` · POST `…/expirations` | `org.manage` | 200/201/201/200/200 | `invitations.controller.ts:125-274` |
| POST `/v1/invitations/previews` (`@Public @NoTenant`) | none | 200 | `invitations.controller.ts:321-324` |
| POST `/v1/invitations/acceptances` (`@NoTenant`, session) | session | 201; 404 token; 409 already member | `invitations.controller.ts:339-341`; `invitations.service.test.ts:239` |
| POST `/v1/invitations/registrations` (`@Public @NoTenant`) | none | 201; 409 address has account; 422 weak password | `invitations.controller.ts:371-374`; `invitations.service.test.ts:309,323` |
| GET `…/settings` · PUT `…/settings/:key` | `org.manage` | 200 | `org-settings.controller.ts:65-81` |
| GET/PATCH `…/client-file-policy`, `…/file-download-policy`; GET/PUT `…/security/file-safety` | `org.manage` / `org.security.manage` | 200 | `client-file-policy.controller.ts:64-76`, `download-scan-policy.controller.ts:56-77`, `file-safety-settings.controller.ts:69-83` |

Exported services (in-process contract): `MembershipResolver` (via `MEMBERSHIP_RESOLVER`), principal loader, organization directory, `ProvisioningService`, workspaces, `InvitationsService`. Web shapes for these routes must be paired in `e2e/contracts/api-web-shapes.ts` (AR-10); this part doc has not audited that file entry by entry.

## Data: tables and migrations

Every tenant table leads its keys with `organization_id` and has `UNIQUE (organization_id, id)` (schema convention, `apps/api/src/common/database/schema-conventions.test.ts:130`).

| Table | Created | Keys that matter |
| --- | --- | --- |
| `organizations` | `0001_tenancy.sql:72` | `uq_organizations_slug` (`:83`); lifecycle columns from `0243_organization_lifecycle_limits.sql`; signup source `0359`, `0368` |
| `memberships` | `0001_tenancy.sql:90` | `role VARCHAR(64)` (`:94`), `status ENUM(...)` (`:95`), `uq_memberships_org_id` (`:105`), `uq_memberships_org_user (organization_id, user_id)` (`:107`); `policy_version`/scope `0023` |
| `workspaces` | `0001_tenancy.sql:119` | — |
| `invitations` | `0005_invitations.sql:46` | `uq_invitations_token (token_hash)` (`:74`); projects `0218` (`invitation_projects`, `:26`) |
| `invitation_pending_keys` | `0319_invitation_pending_keys.sql:29` | `uq_ipk_email (organization_id, email_normalized)` (`:35`): the dedupe key for T-10 |
| `org_settings` | `0058_org_settings.sql:47` | `uq_org_settings_org_key (organization_id, setting_key)` (`:69`) |
| `custom_roles` | `0071_custom_roles.sql:36` | `uq_custom_roles_org_name` (`:57`); capability backfill `0248` |
| `membership_permission_overrides` | `0242_membership_permission_overrides.sql:32` | `uq_mpo_live (organization_id, membership_id, capability, revoked_at)` (`:50`): **NULLs are distinct, so "one live row per capability" is kept by the writer, not by the key** (`:15-16`) |
| `organization_logos` | `0229_organization_logo_images.sql:21` | — |

Also read here, owned elsewhere (AR-7 to confirm in `table-owners.json`): `project_memberships`, `client_organizations`, `client_memberships` (`0001_tenancy.sql:157,181,195`), `organization_limits` (`0243:35`).

Retention: memberships and overrides are kept (status/revoked_at), never hard-deleted; organizations are soft-deleted until `purge_after` (PA-01, 0243). Migrations are forward-only (DA-4) and must be MariaDB-safe (DA-5, `pnpm check:mariadb`).

## Permissions and tenant rules

- **Guard chain (SE-1)**, global, in order: `DurableThrottleGuard → SessionAuthGuard → CsrfGuard → TenantContextGuard → TwoStepRequirementGuard → CapabilityGuard` (`apps/api/src/app.module.ts:1264-1270`). This matches SE-1. Tenancy is the decision point of step 4: `orgSlug` is a **claim under test** passed to `MembershipResolver.resolve()` (`tenant-context.guard.ts:103`); no session → 401 (`:202`); not resolved → 404 (`:229`); suspended → 403 (`:227`); a PAT bound to another org → the same 404 (`:235-248`).
- The workspace id comes from the resolved context, never from a body (DA-12). Tenant tables pass the tenant guard (`api-common/database`).
- `@Public() @NoTenant()` routes: invitation preview and registration only (`invitations.controller.ts:321-322,371-372`); acceptance is `@NoTenant` with a session.
- **Org switches** narrow only (`org-policy.ts:9-15`), asked by the route after its capability check (`requireOrgPermission`, `:50`).
- **Single sources of truth (AR-8):** role vocabulary and capability ceilings = `@tmanage/domain`; who-may-grant = `role-grant-ceiling.ts`; override legality = `override-ceiling.ts`; client ceiling = `client-role-ceiling.ts` + domain `client-ceiling.ts`.
- **Duplicated role sets (DC-2 risk):** "admin roles" `{owner, org_admin, workspace_admin}` is written at `org-policy.ts:18` and again in domain `TWO_STEP_ADMIN_ROLES` (`packages/domain/src/security/sign-in-policy.ts:27-31`); org-wide default roles at `principal.repository.ts:42`. The web has its own, already divergent copy: `apps/web/src/components/meetings/CalendarConnections.tsx:61` `OWNER_ROLES = {owner, org_admin, admin}` (`admin` is not a role; `workspace_admin` is missing), softened by `capabilities.includes('org.manage')` at `:84-85`. Re-verified at HEAD.

## Runtime, background work and failure modes

- Background work owned: invitation delivery and expiry sweep run in the worker (`apps/worker/src/invitations`, `apps/worker/src/common/database/invitations-sweep-store.ts`); per PART-DOCS §3.2 they belong to this part. Invitation mail leaves through the outbox (AS-1), see `invitations-delivery-stopped.test.ts`.
- **DB failure:** a resolver read that throws is rethrown (`tenant-context.guard.ts:231`) and becomes a generic 500 in `HttpExceptionFilter` — not 503 + `Retry-After` (HT-1 gap, owned by `api-common/database`/http). Clients must treat 5xx as `unknown`, never as "not a member" (DC-1, HT-2).
- **Concurrency (DA-1):** role change uses optimistic `version` (T-8). The last-owner rule (T-7) is a **count-then-write on other rows** with no lock (no `FOR UPDATE` anywhere in this folder, grep): two owners demoting each other concurrently at REPEATABLE READ can both pass, leaving zero owners (write skew). Override replace (revoke + insert) relies on InnoDB row/gap locks; under MariaDB 11.8 `innodb_snapshot_isolation=ON` a contended replace may fail with `ER_CHECKREAD` 1020 and there is no shared retry (DA-2, DC-5 class).
- **First-owner / invitation registration** run in dedicated transactions with `GET_LOCK` (`tenant-context.ts:804-862`; `invitations.service.ts:740`).
- **Two instances (RT-2):** this module keeps no process state of its own besides caches keyed on `policy_version`; duplicates are harmless.
- Stability patterns: Fail fast (404/403 before any handler work), Shed load (throttle guard first, ST-8). No outbound calls; ST-1/ST-4 n/a.

## UX rules for its screens

n/a — reason: an API module. Its screens (People, Roles and permissions, Invitations, Organization settings, invitation accept/register) are web route areas with their own `PART.md`. Constraint they inherit: decisions (assignable roles, editable overrides, owner seat) must be read from this API (AR-9), never re-derived from `role === 'owner'` (see ARCH-REVIEW DC-2 sweep: `MemberOverridesScreen.tsx`, `people-format.ts`, `ChangeRoleDialog.tsx`).

## Standards that apply

| Rule | Today | Target |
| --- | --- | --- |
| SE-1 | Met: chain order `app.module.ts:1264-1270`; tenancy is step 4. | Route census + permission map checked in the same commit (fitness function to build). |
| AR-5 | **Violated:** 69 non-test files outside this folder import a tenancy repository (`memberships.repository.js` 45 imports, `org-settings.repository.js` 38, `membership-resolver` 13, `principal` 10, …) from 25 modules (admin, calendar, clients, … work). `membershipsRepository` is a module export. | Publish read services (`MembershipQueries`, `OrgSettingsQueries`); ratchet in `module-boundaries.mjs`. |
| AR-7 | Owner implicit; `project_memberships`/`client_*` created in `0001_tenancy.sql` but used by projects/clients. | `table-owners.json` entry per table. |
| AR-8 | Partial: ceilings and capabilities shared via domain; admin-role set written 3× (§5). | Export `ADMIN_ROLES`, org-wide roles from `@tmanage/domain`; API returns `assignable` everywhere. |
| AR-9 | `effective-permissions` and overrides list return decisions (owner not editable, `membership-overrides.controller.test.ts:257`). | All role pickers read `assignable` from the API. |
| AR-12 | `role` is `VARCHAR(64)` in the DB (`0001:94`), parsed into `InternalRole` at the resolver (`role_not_recognised`). | Keep: parse once at the boundary. |
| DA-1 | Version CAS on role change; **last-owner write skew unguarded** (TEN-D1). | Lock owner rows (`SELECT … FOR UPDATE` on owners of the org, fixed order) or an owner-count row. |
| DA-2 | No shared write-conflict retry here. | Use `withWriteConflictRetry()` once built (api-common/database). |
| DA-11 | Role, override, profile changes write one audit row in the same transaction (`member-role.controller.test.ts:111`, `membership-overrides.controller.test.ts:174`). | Keep. |
| DA-12 | Context from session; cross-tenant tests: `tenant-isolation.db.test.ts`, `membership-overrides.controller.test.ts:194`. | Every new table here gets a cross-tenant db test. |
| HT-1 | 401/403/404/409/422 used as specified; 202 for the async reset mail. | DB outage → 503 (shared fix). |
| HT-4 | Natural unique keys: `uq_ipk_email`, `uq_memberships_org_user`. | `Idempotency-Key` on invitation create if clients retry. |

## How to change this part

1. **New org-scoped route:** controller under this folder with `@RequireCapability(...)`; inject services only (AR-6); add it to the route census/permission map; decide 404 vs 403 per T-1.
2. **New role or capability:** change `packages/domain/src/policies/capabilities.ts` first (the only vocabulary), then ceilings (`role-grant-ceiling.ts`, `client-role-ceiling.ts`), then `test-001-role-matrix.db.test.ts`. Never add a role literal here or in the web.
3. **New org switch:** add the key to `org-settings.allowlist.ts`, the "still allowed" rule to `org-policy.ts:24-32`, and call `requireOrgPermission` after the capability check.
4. **New table:** migration in `apps/api/migrations/NNNN_*.sql` (MariaDB-safe, expand-only), `(organization_id, id)` unique, entry in `TENANT_TABLES` (`common/database/tenant-guard.ts:67`), grants in `scripts/db/users.sql` (DA-9), a cross-tenant db test.
5. **Membership-changing write:** bump `policy_version`, write the audit row in the same transaction, name the anomaly (DA-1).
6. Checks: `pnpm --filter @tmanage/api typecheck`, unit tests in this folder, the db suites listed in §10, `pnpm check:mariadb`.

## Tests and fitness checks

- Unit (this folder): `member-role.controller.test.ts`, `member-bulk-role.controller.test.ts`, `membership-overrides.controller.test.ts`, `override-ceiling.test.ts`, `role-grant-ceiling.test.ts`, `invitations.service.test.ts`, `b11-duplicate-invitation.test.ts`, `offboarding.controller.test.ts`, `membership-resolver.repository.test.ts`, `platform-support-exclusion.test.ts`, `wave11-q4-suspended-staff-client.test.ts`, `scope-and-policy-version.test.ts`, `org-settings.*.test.ts`, `svg-sanitizer.test.ts`, `provisioning.first-owner.test.ts`.
- DB (`apps/api/test/`, real MariaDB): `tenant-isolation.db.test.ts`, `membership-resolver.db.test.ts`, `tenancy-repositories.db.test.ts`, `perm-001-membership-overrides.db.test.ts`, `sec-011-role-escalation.db.test.ts`, `sec-002-role-prohibitions.db.test.ts`, `auth-053-custom-roles-ceiling.db.test.ts`, `ten-003-invitations.db.test.ts`, `ten-004-invitation-projects.db.test.ts`, `mem-002-members-route.db.test.ts`, `test-001-role-matrix.db.test.ts`, `plat-015-org-lifecycle.db.test.ts`.
- Fitness: schema convention (`schema-conventions.test.ts`), MariaDB compat (`pnpm check:mariadb`), raw-SQL / mysql2 import lint (`eslint.config.js`). **Missing:** AR-5 module-boundary check, AR-8 role-literal lint, an N-racer test for T-7.

## Open defects, decisions and risks

| Id | Class | Finding | Pri | Exit |
| --- | --- | --- | --- | --- |
| TEN-D1 | DC-5 (DA-1) | Last-owner check is count-then-write without a lock (`member-role.controller.ts:244-257`; same shape in bulk role and offboarding). Two concurrent demotions can leave no owner. | P1 | Lock the org's owner rows in a fixed order inside the transaction; 2-racer db test. |
| TEN-D2 | DC-2 | Admin-role set in 3 places (`org-policy.ts:18`, domain `sign-in-policy.ts:27`, web `CalendarConnections.tsx:61` already wrong: `admin` vs `workspace_admin`). | P1 | One export in `@tmanage/domain`; AR-8 lint on role literals. |
| TEN-D3 | AR-5 | 69 outside files import tenancy repositories; `membershipsRepository` is exported. | P1 | Read services + ratchet baseline. |
| TEN-D4 | DC-5 (DA-2) | Override replace has no write-conflict retry; 1020 possible under MariaDB snapshot isolation (inferred, not reproduced). | P2 | Shared retry helper; contended db test. |
| TEN-D5 | AR-11 | `invitationStateMachine`, `offboardingStateMachine` in domain are unused; transitions decided in services. | P2 | Use them in `invitations.service.ts`/`offboarding.service.ts` or delete. |
| TEN-D6 | DC-1 (HT-1) | Resolver DB failure → 500, not 503 + `Retry-After`. | P1 | Shared mapping in `HttpExceptionFilter` (api-common/database owner). |

ADRs: ADR-0001 (tenant isolation by query), ADR-0006 (trust zones staff/client). DC-6 (client gets staff layout) depends on the session answer carrying the audience; this module's `Principal.kind` (`internal|client`) is the source.

## Glossary

| Term | Meaning |
| --- | --- |
| Organization | The customer company; the tenant. UI "workspace" in some screens. |
| Membership | One person's role in one organization (`memberships`). Client people use `client_memberships`. |
| Principal | The resolved actor: kind (`internal`/`client`), role, scope, overrides, effective capabilities. |
| Policy version | Per-membership authorization epoch; bumped on every role/scope/override change. |
| Override | A per-member allow/deny of one capability, bounded by the caller's own rights. |
| Support session | A time-boxed hidden `platform_support` membership used by TManage staff. |
