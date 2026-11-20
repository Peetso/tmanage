---
part: api/clients
kind: api-module
context: client-portal
owner: implementation-lead
lifecycle: production
depends_on:
  [
    api-common/database,
    api-common/http,
    api/audit,
    api/platform,
    api/tenancy,
    api/projects,
    api/work,
    api/approvals,
    api/files,
    api/requests,
    package/domain,
  ]
provides_api:
  [
    '/v1/organizations/:orgSlug/client-organizations/*',
    '/v1/organizations/:orgSlug/client-organization-options',
    '/v1/organizations/:orgSlug/client-memberships/*',
    '/v1/organizations/:orgSlug/projects/:projectId/clients/*',
    '/v1/organizations/:orgSlug/projects/:projectId/client',
    '/v1/organizations/:orgSlug/projects/:projectId/updates/*',
    '/v1/organizations/:orgSlug/projects/:projectId/milestones/*',
    '/v1/organizations/:orgSlug/projects/:projectId/milestone-plan',
    '/v1/organizations/:orgSlug/projects/:projectId/risks',
    '/v1/organizations/:orgSlug/projects/:projectId/portal-settings',
    '/v1/organizations/:orgSlug/projects/:projectId/portal-access-log',
    '/v1/organizations/:orgSlug/portal/*',
  ]
consumes_api: []
tables_owned:
  [
    client_organizations,
    client_memberships,
    project_clients,
    project_updates,
    project_update_comments,
    project_milestones,
    project_risks,
    portal_access_log,
    portal_settings,
    portal_announcements,
    portal_client_messages,
  ]
rules:
  [
    SE-1,
    AR-4,
    AR-5,
    AR-6,
    AR-7,
    AR-8,
    AR-9,
    AR-10,
    HT-1,
    HT-3,
    HT-4,
    DA-1,
    DA-10,
    DA-11,
    DA-12,
    AS-1,
    AS-3,
    ST-6,
    OB-4,
    PR-3,
    QM-2,
    IP-3,
    IP-5,
  ]
ux_rules: []
last_verified_commit: 3b7e4fa70eb6facff3f1dccc65c0867f0707a0a6
last_verified_date: 2026-11-20
last_verified_by: Claude Opus 5.5 (lane H)
---

# api/clients

Read this before changing any file under `apps/api/src/modules/clients/**`. Rule IDs refer to
`docs/architecture/ENGINEERING-STANDARD.md` (AR, HT, DA, AS, ST, SE, PR, QM, OB),
`IMPLEMENTATION-PATTERNS.md` (IP) and `UI-UX-DESIGN-STANDARD.md` (UX). Every `file:line` was
checked at `3b7e4fa7`. Paths are relative to this folder unless they start with `apps/`, `e2e/`,
`packages/` or `docs/`.

## Purpose and bounded context

**What it is for.** This module is the core of the **Client Portal** context (VIEWS §4). It
answers two kinds of question:

1. _Staff side_ — who are this workspace's client companies (`client_organizations`), who are
   their people (`client_memberships`, with role and expiry), which projects are shared with
   which client (`project_clients`), and what the team publishes to them: project updates,
   milestones, risks, announcements, portal settings, and the access log of who looked.
2. _Client side_ (the **client trust zone**, every route under `…/portal/*`) — what a client
   member may see: their projects, client-visible work items, published deliverables and their
   files, updates (with comments), milestones, risks, people, announcements, messages, and their
   own requests.

**Who uses it.** The staff screens under `apps/web/src/app/[orgSlug]/clients/**` (part
`web/org/clients`) and project settings; the portal screens under
`apps/web/src/app/[orgSlug]/portal/**`; the sibling module `apps/api/src/modules/portal`
(branding, journey, chat, invoices, budget — a second portal module, §11); AI actions
(`apps/api/src/modules/ai-actions/registry/clients.ts`).

**Context map (VIEWS §4).** Client Portal is **downstream** of Work Management, Files and
Tenancy, and nothing is downstream of it. Relations:

- projects: **constructs `ProjectsRepository` itself** in seven providers (`clients.module.ts:31,148,165,187`).
- work: constructs `WorkItemsRepository` for the portal work list (`:78,188`).
- approvals: constructs `ClientProjectionsRepository` (`:79,189`).
- files: constructs `FileAssetsRepository`, `ReviewThreadsRepository`, `ClientFileSharing` (`:80-82,190-195`).
- tenancy: constructs its own `InvitationsService` with tenancy repositories (`:83-85,225-229`).
- requests: constructs `ClientRequestsService` with requests, projects, work, client-org repositories (`:86-87,256-265`).
- shared kernel: `AUDIT_SERVICE`, `OutboxEventsRepository` (`:28,30`); `authorize()` rules 7–10 in
  `packages/domain/src/policies/authorize.ts:347-372`.

The module's own reason for constructing other modules' repositories — "reaching for another
module's provider would register that dynamic module twice" (`clients.module.ts:153-157,181-184`)
— is a wiring constraint, not an exemption: it is the AR-5/AR-7 breach VIEWS §4 names
("`projects.repository` is imported 68 times").

## Domain model and invariants

**Entities.** `ClientOrganization` (a client company; `DELETE` archives, never hard-deletes),
`ClientMembership` (a person in a client company: `role` = `ClientRole` from `@tmanage/domain`,
`status`, optional `expiresAt`), `ProjectClient` (share of a project with a client company),
`ProjectUpdate` (draft → published → unpublished), `UpdateComment`, `ProjectMilestone` (with a
published client copy), `ProjectRisk`, `PortalAnnouncement`, `PortalClientMessage`,
`PortalSettings` (per project), `PortalAccessLogEntry`.

**Audiences.** A client may only see `client_visible` and `client_action_required`; `internal`
"is not among them and never will be" (`portal.service.ts:334-335`). Portal status
`waiting_on_you` derives from the audience, but a terminal state wins (`portal.service.ts:394-403`).

**Membership activity.** "Active now" is one SQL predicate,
`expires_at is null or expires_at > current_timestamp(3)` (`client-memberships.repository.ts:136`).
Default expiry: `CLIENT_MEMBERSHIP_DEFAULT_EXPIRY_DAYS` (`apps/api/src/common/http/api-config.ts:93,290`,
passed at `clients.module.ts:138`).

**Invariants (checkable)** — statement · where enforced · proof:

- **I-1** A client principal never reads an object of another client organization in the same
  tenant · `authorize()` rule 7, `packages/domain/src/policies/authorize.ts:347-357` ·
  `apps/api/test/sec-001-client-projection.db.test.ts`, `wave10-r5-resolver-shadowed-client.test.ts`.
- **I-2** `internal` audience is invisible to clients, and the audience filter is a **query
  predicate**, not a post-filter · rule 8 `authorize.ts:359`; `portal.service.ts:581-610` ·
  `apps/api/test/client-002-portal.db.test.ts`.
- **I-3** Unpublished content is not client-reachable · rule 9 `authorize.ts:364-367` ·
  `apps/api/test/portal-003-updates.db.test.ts`.
- **I-4** A project is client-readable only if shared with that client organization; a client's
  `projectIds` come from `project_clients` alone · rule 10 `authorize.ts:370-372`, comment
  `portal-people.controller.ts:52-57` · `client-002-portal.db.test.ts`.
- **I-5** Unknown, cross-tenant **or not-shared** project ids answer **404, not 403** on portal
  routes (no existence oracle) · `portal-people.controller.ts:72-80` · `portal-people.controller.test.ts`.
- **I-6** A portal page holds `limit` _readable_ rows, not one repository page minus unreadable
  ones (R07) · `portal.service.ts:541-572,589-603` · `apps/api/test/client-002-portal-pagination.db.test.ts`.
- **I-7** Deliverable files offered to a client obey the one sharing rule · `clients.module.ts:194-195`
  → `apps/api/src/modules/files/client-file-sharing.ts:46-64` · `files/client-file-sharing.test.ts`.
- **I-8** A failed access-log write never fails the client's read · `portal.service.ts:524-529` ·
  `portal.service.test.ts`.
- **I-9** Milestone publish writes client copy, audit row and `milestone.published.v1` outbox row
  in **one transaction** · `milestone-lifecycle.controller.ts:375-389` · `milestone-lifecycle.controller.test.ts`.
- **I-10** Unpublish is idempotent (no copy → still 204) · `milestone-lifecycle.controller.ts:395`,
  route `:759-761` · same test.
- **I-11** The portal people projection is `{displayName, role}` only — never e-mail, membership
  id or user id · `portal-people.controller.ts:59-61` · contract `_portalPerson`
  `e2e/contracts/api-web-shapes.ts:1282`.

## Public API and contracts

Every route is under the global guard chain (§5) and carries `@RequireCapability`. Status codes
follow HT-1 (403 from `CapabilityGuard`, 404 for hidden objects). Paths below are under
`/v1/organizations/:orgSlug`.

**Staff routes (trust zone: internal).**

- `org.manage`: GET `client-organizations` (`clients.controller.ts:113-114`); GET
  `client-organizations/:id` · `/invitations` · `/projects` (`:197-198`, `:144-145`, `:181-182`);
  POST 201 · PATCH · DELETE (archive) `client-organizations[/:id]` (`:207-209`, `:224-225`,
  `:253-254`); GET `client-organizations/:id/summary`, the client page's one read
  (`client-summary.controller.ts:14-19`).
- `project.create`: GET `client-organization-options`, the project picker (`clients.controller.ts:128-129`).
- `client_member.manage`: GET · POST 201 · PATCH `client-memberships[/:id]` (`:265-266`,
  `:304-306`, `:352-353`); GET `portal/messages/admin` (`client-messages.controller.ts:91-92`);
  POST 201 · DELETE 204 `portal/:clientId/announcements[/:id]` (`portal-announcements.controller.ts:89-114`);
  POST 201 `portal/client-members` (`portal.controller.ts:246-248`).
- `project.manage`: GET · POST 201 `projects/:projectId/clients`, PUT `…/client`, DELETE 204
  `…/clients/:clientOrganizationId` (`clients.controller.ts:409-463`); updates GET · POST 201,
  PATCH `…/updates/:id`, POST `…/:id/unpublish` (`project-updates.controller.ts:67-79`,
  `update-lifecycle.controller.ts:46-47,109-111`); update comments GET · POST 201
  (`update-comments.controller.ts:51-68`); milestones GET · POST 201, `milestone-plan`, PATCH ·
  DELETE 204 `milestones/:id`, POST 200 · DELETE 204 `…/publish`, POST 200 `…/complete`
  (`project-milestones.controller.ts:295-308`, `milestone-lifecycle.controller.ts:707-773`);
  risks GET · POST 201 (`project-risks.controller.ts:336-349`); GET · PUT `portal-settings`
  (`portal-settings.controller.ts:198-209`); GET `portal-access-log` (`portal-access-log.controller.ts:220-221`).

**Client routes (trust zone: client; `client_projection.read` unless noted).** Under `…/portal`:

- GET `projects`, `work-items`, `projects/:id/deliverables`, `deliverables/:id/files`,
  `projects/:id/updates` (`portal.controller.ts:59-136`).
- `client_request.submit`: POST 201 · GET `requests`, GET `requests/:id`, POST 200
  `requests/:id/withdrawal` (`portal.controller.ts:161-215`).
- GET `projects/:id/people` (`portal-people.controller.ts:64-65`), `…/portal-settings`
  (`portal-settings.controller.ts:228-229`), `…/milestones` (`project-milestones.controller.ts:328-329`),
  `…/risks` (`project-risks.controller.ts:368-369`), `…/updates/:updateId/comments`
  (`update-comments.controller.ts:86-91`).
- GET `:clientId/announcements` (`portal-announcements.controller.ts:76-77`); GET · POST 201
  `messages` (`client-messages.controller.ts:63-78`).

**Contracts (AR-10).** `e2e/contracts/api-web-shapes.ts:1246-1297` pairs every portal view
(`_portalProject`, `_portalUpdate`, `_clientMessage`, `_portalSettings`, `_portalFile`,
`_portalPerson`, `_portalWorkItem`, `_portalDeliverable`, `_clientMilestone`, `_projectClient`,
`_clientOrganization`, …) with its web type.

**Exported services.** `CLIENTS_SERVICE`, `PORTAL_SERVICE` (`clients.module.ts:409`).

**Events.** Outbox: `milestone.published.v1` (`milestone-lifecycle.controller.ts:384-388`).
Audit actions: `client_organization.{created,updated,archived}`,
`client_membership.{invited,role_changed,expiry_changed,status_changed}`,
`project.client_{linked,unlinked}` (`clients.service.ts:256-737`),
`milestone.{date_changed,published,unpublished}` (`milestone-lifecycle.controller.ts:319,379,410`).

## Data: tables and migrations

| Table                     | Created                              | Keys / notes                                                          | Retention                     |
| ------------------------- | ------------------------------------ | --------------------------------------------------------------------- | ----------------------------- |
| `client_organizations`    | `0001_tenancy.sql`                   | tenant-scoped; archive, not delete                                    | tenant lifetime               |
| `client_memberships`      | `0001_tenancy.sql`                   | `expires_at` nullable; "active" predicate `client-memberships.repository.ts:136` | expired rows kept (no purge found) |
| `project_clients`         | `0001_tenancy.sql`                   | the only source of a client's `projectIds`                            | tenant lifetime               |
| `project_updates`         | `0041_project_updates.sql`           | published/unpublished lifecycle                                       | tenant lifetime               |
| `project_milestones`      | `0048_project_milestones.sql`        | client copy via approvals' projections                                | tenant lifetime               |
| `project_risks`           | `0049_project_risks.sql`             | severity/status                                                       | tenant lifetime               |
| `project_update_comments` | `0084_project_update_comments.sql`   | —                                                                     | tenant lifetime               |
| `portal_access_log`       | `0109_portal_access_log.sql`         | append; one row per client read                                       | **grows unbounded** (ST-6, §11) |
| `portal_settings`         | `0110_portal_settings.sql`           | per project                                                           | tenant lifetime               |
| `portal_announcements`    | `0172_portal_announcements.sql`      | —                                                                     | tenant lifetime               |
| `portal_client_messages`  | `0190_portal_client_messages.sql`    | Drizzle `portalClientMessages`                                        | tenant lifetime               |

**Read but not owned:** `projects` (owner projects), `work_items` (work), `client_projections`
(approvals), `file_assets`/`file_versions`/`review_threads` (files), `invitations`/`memberships`
(tenancy), `client_requests` (requests), `project_memberships`/`users` (`portal-people.repository.ts`
imports `projectMemberships, users` from the schema). Conversely, at least 20 non-test files in
other modules read `client_organizations`/`client_memberships`/`project_clients` directly (e.g.
`apps/api/src/modules/files/review-mention-candidates.repository.ts:6-8`,
`apps/api/src/modules/identity/sign-in-policy.repository.ts`,
`apps/api/src/modules/finance/client-invoices.repository.ts`).

**Time.** 28 `current_timestamp(3)` writes across the module's repositories (e.g.
`client-memberships.repository.ts:312-313,329,367,412`, `portal-access-log.repository.ts:80`):
DA-10 says row times come from a bound `Date`.

## Permissions and tenant rules

**Guard chain** (SE-1) is global (`apps/api/src/app.module.ts`): Throttle → Session → CSRF →
TenantContext → TwoStep → Capability. Capabilities on this module's routes: `org.manage`,
`project.create`, `project.manage`, `client_member.manage`, `client_projection.read`,
`client_request.submit` (all in the role ceilings of `packages/domain/src/policies/authorize.ts:222-232`).

| Decision                                    | Single owner                                                     | Consumers                                             |
| ------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| May this principal read this object?        | `authorize()` in `@tmanage/domain` (rules 1–11)                  | `portal.service.ts:1,492`, `portal-people.controller.ts` `mayRead` |
| Which audiences a client may see            | `CLIENT_AUDIENCES` `portal.service.ts:335`                       | portal queries                                        |
| May this client download this file?         | `ClientFileSharing` / `clientFileState` (files module)           | portal deliverable files                              |
| Is a client membership active?              | `ACTIVE_NOW` SQL predicate `client-memberships.repository.ts:136` | membership reads                                      |
| Client vs staff principal                   | `principal.kind === 'client' \|\| isClientRole(role)` `authorize.ts:286` | all of the above                              |

**Tenant scope.** Every repository goes through `tenantDrizzle` with `TenantContext` (DA-12, e.g.
`client-memberships.repository.ts:4,12`). Services add a second capability check on top of the
guard (`clients.service.ts:251` `requireCapability(…,'org.manage',…)`).

**Trust zones.** Portal routes serve **client principals**; staff routes refuse them through role
ceilings (rule 3) and the independent internal-only guard (rule 5, `authorize.ts:324-326`). A
staff member may read portal routes as a preview (internal principal; `portal.service.ts:537`).

## Runtime, background work and failure modes

**Owned background work:** none. Client-request deferral and invitation sweeps run from
`apps/server/scheduled-sweeps.mjs` (owned by requests and tenancy). `milestone.published.v1` is
delivered by the platform outbox relay (AS-1).

- **DB down on a portal read** → error propagates as 5xx; the web can show an error, not "no
  projects" (HT-1, HT-3). Correct on the API side.
- **Access-log write fails** → swallowed by an **empty `catch {}`, no log line**
  (`portal.service.ts:527-529`). The read must succeed (I-8) but the failure must be logged (HT-3, OB-4).
- **Audit or outbox not wired** → `this.audit?.record(…)` / `this.outbox?.append(…)` on optional
  parameters (`clients.service.ts:163`, `milestone-lifecycle.controller.ts:169,384`): a wiring
  mistake skips the audit row or event silently (DA-11, AS-1). Gap, P2.
- **Two processes** → no in-memory state; everything is in the DB (RT-2). Correct.
- **Concurrent membership edits** → single-row conditional updates in the repository; no
  read-modify-write in the service path found, but no concurrency test either (DA-1, P2).

## UX rules for its screens

n/a — API module; screens are owned by `web/org/clients` (staff), the portal web area
(`apps/web/src/app/[orgSlug]/portal`) and project settings. The API's obligation to them is AR-9:
portal visibility, sharing state and "waiting on you" are decided here and returned as fields,
never re-derived in the web.

## Standards that apply

- **SE-1** every route has `@RequireCapability` under the global chain. Keep; add every new portal
  route to the route census.
- **AR-4** SQL only in `*.repository.ts`. Keep.
- **AR-5 / AR-7** **breach**: other modules' repositories constructed here
  (`clients.module.ts:78-87,148,165,187-195`), and ≥20 files elsewhere read client tables. Target:
  owners publish read services; this module publishes a client-access service (is the project
  shared, is the membership active).
- **AR-6** **breach**: `PortalPeopleController` injects and queries repositories
  (`portal-people.controller.ts:31-41,67-69`); four services live inside controller files
  (`project-milestones.controller.ts:102`, `project-risks.controller.ts:111`,
  `milestone-lifecycle.controller.ts:160`, `portal-access-log.controller.ts:88`). Target: own
  `*.service.ts` files.
- **AR-8** visibility decided once in `authorize()`, sharing once in `ClientFileSharing`. Keep.
- **AR-9** the portal returns decisions (`waiting_on_you`, file state). Keep.
- **AR-10** pairs present (`api-web-shapes.ts:1246-1297`). Keep for every new view.
- **HT-1** 404 for not-shared projects (I-5), 403 from the guard. Keep.
- **HT-3** one silent `catch {}` (§6). Log at warn.
- **HT-4** no `Idempotency-Key` handling in this module (grep: none) for client-retryable creates
  (`portal/requests`, `portal/messages`). Add it.
- **DA-1** single-row conditional writes; no concurrency test. Add one for membership edits.
- **DA-10** 28 `current_timestamp(3)` row times. Bound `Date` from the service clock.
- **DA-11** audit rows in the same transaction (`clients.service.ts:253-261`), but `audit` is optional.
- **DA-12** `tenantDrizzle` + `TenantContext` everywhere. Keep.
- **AS-1 / AS-3** outbox row in the transaction (I-9); no `dedupe_key` on `milestone.published.v1`.
  Add one if a consumer is not idempotent.
- **ST-6** `portal_access_log` grows per client read with no purge. Retention class + purge.
- **OB-4** correlation id travels in `TenantContext`; put it on the access-log failure line.
- **PR-3** the 404-not-403 class is fixed route by route; one `requireClientProject()` helper fixes the class.
- **QM-2** security first: oracle-hiding 404 over a helpful 403. Keep.
- **IP-3 / IP-5** `authorize()` is the pure core; repositories + `database.transaction` units of work.

## How to change this part

- **New staff route:** method on the matching controller, `@RequireCapability(...)` from the
  domain capability list; logic in a `*.service.ts` (not inside the controller file); SQL in a
  `*.repository.ts` through `tenantDrizzle` (AR-4, AR-6, DA-12).
- **New client (portal) route:** under `@Controller('v1/organizations/:orgSlug/portal…')`,
  capability `client_projection.read` (or `client_request.submit`). Resolve the project
  tenant-scoped first, then `authorize()`; answer **404** for unknown, cross-tenant and not-shared
  (I-5). Filter audiences in the query with `CLIENT_AUDIENCES` (I-2). Return a projection that
  names no internal ids, e-mails or owners (I-11). Add the API/web pair to
  `e2e/contracts/api-web-shapes.ts` (AR-10) and a row in the route census (SE-1).
- **New publish/unpublish flow:** audit row + outbox row in the same transaction as the state
  change (I-9, DA-11, AS-1); idempotent unpublish (I-10).
- **New table:** forward-only MariaDB-safe migration in `apps/api/migrations/` (DA-4, DA-5),
  grant in `scripts/db/users.sql` (DA-9), a retention class (ST-6).
- **Need another module's data:** do not add another `new XRepository()` to `clients.module.ts`;
  ask the owning module for a read service (AR-5). Record any unavoidable exception in §11.
- Checks: `pnpm --filter @tmanage/api typecheck`, the co-located unit tests, then the db suites in §10.

## Tests and fitness checks

- Unit (co-located): `client-messages.controller.test.ts`, `client-summary.service.test.ts`,
  `clients.service.b10-projects.test.ts`, `clients.service.bk1.test.ts`,
  `clients-people.live-test-fix.test.ts`, `milestone-lifecycle.controller.test.ts`,
  `portal-access-log.controller.test.ts`, `portal-announcements.controller.test.ts`,
  `portal-people.controller.test.ts`, `portal-settings.controller.test.ts`,
  `portal.service.test.ts`, `project-milestones.controller.test.ts`,
  `project-risks.controller.test.ts`, `project-updates.controller.test.ts`,
  `update-comments.controller.test.ts`, `update-lifecycle.controller.test.ts`,
  `wave10-r5-resolver-shadowed-client.test.ts`, `wave10-r5-set-expiry-staff.test.ts`,
  `wave9-s4-clients-portal.test.ts`.
- DB (`apps/api/test`): `client-001-clients.db.test.ts`, `client-002-portal.db.test.ts`,
  `client-002-portal-pagination.db.test.ts`, `client-003-companies-invites-picker.db.test.ts`,
  `portal-003-updates.db.test.ts`, `portal-004-subpages.db.test.ts`,
  `sec-001-client-projection.db.test.ts`, `approvals-002-client-projection.db.test.ts`,
  `inbox-001-portal-inbox.db.test.ts`, `req-001-client-requests.db.test.ts`.
- E2E: `e2e/tests/client-approval-journeys.spec.ts`, `portal-updates-journeys.spec.ts`,
  `fix6-portal-preview-home.spec.ts`, `ux1-share-with-client.spec.ts`.
- Contract: `e2e/contracts/api-web-shapes.ts:1246-1297`.
- Domain: `authorize()` rules are tested in `packages/domain` (policy tests).
- **Missing:** an AR-6 import check that fails on a repository import in `*.controller.ts`; a
  route-level test asserting every `…/portal/*` route answers 404 (not 403) for a not-shared project.

## Open defects, decisions and risks

| Id    | Class        | Finding (verified at 3b7e4fa7)                                                                                                                          | Pri | Exit                                                           |
| ----- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------------------------------------------------------------- |
| CLI-1 | AR-5 / AR-7  | Module constructs repositories of projects, work, approvals, files, tenancy, requests (`clients.module.ts:78-87,148,165,187-195`)                       | P1  | owner read services; delete the `new XRepository()` calls      |
| CLI-2 | AR-6         | `PortalPeopleController` queries repositories directly (`portal-people.controller.ts:31-41,67-69`); four services defined in controller files           | P2  | services in `*.service.ts`; AR-6 import lint                   |
| CLI-3 | HT-3         | Access-log failure swallowed by an empty `catch {}` with no log (`portal.service.ts:527-529`)                                                           | P2  | warn line with correlation id                                  |
| CLI-4 | DA-11 / AS-1 | `audit?` and `outbox?` are optional dependencies (`clients.service.ts:163`, `milestone-lifecycle.controller.ts:169,384`)                               | P2  | required in production wiring; tests pass fakes                |
| CLI-5 | DA-10        | 28 `current_timestamp(3)` row times, incl. the "active membership" predicate (`client-memberships.repository.ts:136`)                                  | P2  | bound `Date`; db test that the pool `time_zone` is UTC         |
| CLI-6 | ST-6         | `portal_access_log` has no retention or purge                                                                                                           | P2  | retention class + purge sweep                                  |
| CLI-7 | DC-2 risk    | Two portal API modules (`modules/clients` portal routes and `modules/portal`) share the `/portal` prefix; client-visibility rules must stay in `authorize()` for both | P2  | one portal read service; `modules/portal` documented in its own PART.md |
| CLI-8 | HT-4         | client-retryable creates (`portal/requests`, `portal/messages`) have no `Idempotency-Key`                                                               | P2  | idempotency key on both                                        |

DC classes checked: DC-1 (API side) none found; DC-2 none in this module (rules sit in
`authorize()`); DC-6 is a web concern (see `web/org/clients`); DC-3/DC-4/DC-7 not applicable (no
jobs owned).

## Glossary

| Term                   | Meaning                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| Client organization    | a customer company of the workspace (AR `RouteTitle.clientCompany`: شركة العميل)                                         |
| Client member          | a person of a client company with portal access; role `ClientRole`, optional expiry           |
| Share (project client) | a `project_clients` row: the project is visible in that client's portal                      |
| Audience               | `internal`, `client_visible`, `client_action_required`; only the last two reach a client      |
| Portal preview         | an internal person reading portal routes to see what a client sees                            |
