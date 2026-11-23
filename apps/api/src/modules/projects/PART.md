---
part: api/projects
kind: api-module
context: work-management
owner: implementation-lead
lifecycle: production
depends_on:
  [
    api-common/database,
    api-common/http,
    api/audit,
    api/platform,
    api/tenancy,
    api/work,
    api/clients,
    package/domain,
  ]
provides_api:
  [
    '/v1/organizations/:orgSlug/projects',
    '/v1/organizations/:orgSlug/projects/:projectId',
    '/v1/organizations/:orgSlug/projects/:projectId/{members,summary,health,budget,baselines,phases,dependencies,custom-fields,objectives,tags,favorite,export,retro-notes,risk-register,status-updates,suggest-due}',
    '/v1/organizations/:orgSlug/projects/{portfolio,health,favorites,custom-fields,templates,templates/packs,tags,milestones/:milestoneId/links}',
    '/v1/organizations/:orgSlug/objectives/*',
  ]
consumes_api: []
tables_owned:
  [
    projects,
    project_memberships,
    project_objectives,
    org_objectives,
    objective_work_links,
    objective_key_results,
    project_internal_risks,
    project_templates,
    project_status_updates,
    milestone_links,
    project_tags,
    project_favorites,
    project_budgets,
    project_budget_phases,
    budget_alert_events,
    project_phases,
    project_baselines,
    project_baseline_items,
    project_dependencies,
    project_custom_fields,
    project_retro_notes,
    template_packs,
  ]
rules:
  [
    AR-4,
    AR-5,
    AR-6,
    AR-7,
    AR-8,
    AR-9,
    AR-10,
    HT-1,
    HT-4,
    DA-1,
    DA-3,
    DA-6,
    DA-9,
    DA-10,
    DA-11,
    DA-12,
    AS-1,
    AS-2,
    SE-1,
    PR-3,
    IP-5,
    IP-7,
  ]
ux_rules: []
last_verified_commit: 3b7e4fa70eb6facff3f1dccc65c0867f0707a0a6
last_verified_date: 2026-11-20
last_verified_by: Claude Opus 5.5 (lane H)
---

# api/projects

Read this before changing any file under `apps/api/src/modules/projects/**`. Rule IDs refer to
`docs/architecture/ENGINEERING-STANDARD.md` (AR, HT, DA, AS, SE, PR),
`IMPLEMENTATION-PATTERNS.md` (IP) and `UI-UX-DESIGN-STANDARD.md` (UX). Every `file:line` was
checked at `3b7e4fa7`. Paths are relative to this folder unless they start with `apps/`, `e2e/`,
`packages/`, `scripts/` or `docs/`.

## Purpose and bounded context

**What it is for.** A project is the container every piece of delivery work lives in. This
module owns the project row and everything a team plans _about_ a project rather than _inside_
it: membership and project roles, objectives and key results (project and organisation level),
budget and budget burn, phases, baselines, project-to-project dependencies, internal risk
register, retro notes, status updates, tags, favourites, custom fields, templates and template
packs, the portfolio and health read models, the project summary (overview blocks), CSV/JSON
export and the due-date suggestion. 131 files, 24 controllers (`grep -c @Controller`).

The work items themselves are **not** here: they belong to `api/work`. Client-facing milestones,
client risks, project updates and the project↔client share live in `api/clients`
(`clients/project-milestones.repository.ts`, `project-risks.repository.ts`,
`project-clients.repository.ts`).

**Who uses it.** Every staff screen under `apps/web/src/app/[orgSlug]/projects/**` (part
`web/org/projects`), the work list's project filter (`web/org/work`), the portal (through
`api/clients`), and 69 non-test files in other API modules that import `projects.repository.js`
directly (§11).

**Context map (VIEWS §4).** Work Management is **upstream (supplier)** of Client Portal,
Finance and Collaboration; Identity, Tenancy, Audit and Platform (outbox) are its shared kernel.

| Direction | Partner | How | Evidence |
| --- | --- | --- | --- |
| upstream of | 21 modules (files, clients, insights, …) | **direct import of `ProjectsRepository`** — 69 non-test files in `apps/api/src` outside this folder | `grep -rl "projects/projects.repository.js'"`; largest: files 19, clients 19, import 11 |
| upstream of | clients, time, quotes | `ProjectsService.createInTransaction` for "Convert to project" (52-08) | `projects.service.ts:240-250` |
| downstream of | tenancy | `requireOrgPermission(..., 'members_can_create_projects')`; reads `memberships`, `workspaces` | `projects.service.ts:122-128`, `portfolio.repository.ts:7`, `projects.repository.ts:312` |
| downstream of | clients (portal context) | **reads its tables** `project_milestones`, `project_risks`, `client_organizations`, `project_clients` | `health.repository.ts:5,7`, `baseline.repository.ts:7`, `portfolio.repository.ts:6-9` |
| downstream of | people, approvals, collaboration | reads `member_profiles`, `person_allocations`, `person_capacity`, `approvals`; **deletes** `conversation_memberships` | `portfolio-capacity.repository.ts:18-21`, `portfolio.repository.ts:5`, `project-memberships.repository.ts:401-408` |
| downstream of | audit, platform | `AuditService.record`, `OutboxEventsRepository.append` inside the unit of work | `projects.service.ts:262-286`, `project-memberships.service.ts:74` |
| peer | work (same context) | reads `work_items`, `work_item_time_logs`, `work_item_schedule_stats` | `project-export.repository.ts:3` |

## Domain model and invariants

**Entities.** `Project` (`projects`: id, organization, workspace, name ≤ 190, owner, `forecast_at`
DATE target, `committed_at`, `archived_at`, `version`), `ProjectMembership` (project role from the
fixed internal roles), `ProjectObjective`/`OrgObjective`/`KeyResult`/`ObjectiveWorkLink`,
`ProjectBudget` + `BudgetPhase` + `BudgetAlertEvent`, `Phase`, `Baseline` + `BaselineItem`
(snapshot of milestones and items), `ProjectDependency`, `ProjectCustomField`, `InternalRisk`,
`RetroNote`, `StatusUpdate` (band), `Tag`, `Favorite`, `ProjectTemplate`, `TemplatePack`.

**Value objects.** Target date is a calendar-date string `YYYY-MM-DD`, never an instant
(`projects.controller.ts:161-175`, column `DATE` since migration 0012). Status bands, risk
impact/likelihood/status and custom-field types are closed enums exported from
`apps/api/src/common/database/schema.ts` (`PROJECT_STATUS_BANDS`, `PROJECT_INTERNAL_RISK_*`,
`PROJECT_CUSTOM_FIELD_TYPES`).

**Lifecycle.** `active` ⇄ `archived` (`archived_at` set or cleared), then removed when empty
(fix lane C, 2026-11-23, closes PRJ-4). `PATCH /projects/:projectId` renames (`project.manage`,
`expectedUpdatedAt` optimistic check, 409 when stale or archived); `POST …/archive` and
`POST …/unarchive` move it (`project.manage`, a repeat is a no-op without an audit row);
`DELETE /projects/:projectId` (`project.delete`) deletes a project that holds nothing — its
favourites and memberships go with it, anything else (work, files, documents, money) makes the
foreign key refuse and the answer is 409 `project_not_empty` (archive instead). Each writes its
audit row (`project.renamed|archived|unarchived|deleted`) in the same transaction (DA-11); a
project the caller cannot read stays 404 (I-4). The AI reaches them as `projects.update|archive|
unarchive|delete` (`ai-actions/registry/parity-b4-lifecycle.ts`), all confirm-class.

**Invariants (checkable)**

| # | Invariant | Where enforced | Proof |
| --- | --- | --- | --- |
| I-1 | Creating a project needs `project.create` **and** the org switch "Members can create projects"; every create path (POST, template, quote conversion) passes it. | `projects.service.ts:108-130`, called from `create` `:231` | `projects.service.test.ts`, `apps/api/test/proj-001-project-creation.db.test.ts` |
| I-2 | The creator becomes the project's manager in the same transaction, so a non-org-scoped manager can read what they made. | `projects.service.ts:255-271` | `proj-001-project-creation.db.test.ts` |
| I-3 | Project creation writes two audit rows (`project_membership.granted`, `project.created`) in the creating transaction (DA-11). | `projects.service.ts:262-286` | `projects.service.test.ts` |
| I-4 | A project the principal has no relation to answers **404**, not 403 (no enumeration). | `projects.service.ts:180-203` | `apps/api/test/projects-repository.db.test.ts` |
| I-5 | Every repository statement binds `organization_id` from `TenantContext`, never from the payload. | `projects.repository.ts:19-23,132,160` | `proj-001-repositories.db.test.ts` |
| I-6 | A workspace from another tenant is refused by the composite FK `fk_projects_workspace_tenant`. | `apps/api/migrations/0001_tenancy.sql:151` | `proj-001-project-creation.db.test.ts` |
| I-7 | A member cannot grant a project role above their own, nor change their own role. | `project-members.controller.ts:64-69,188-190` | `project-members.controller.test.ts` |
| I-8 | Archiving twice is not an error (idempotent), and writes no second audit row. | `projects.service.ts` `setArchived` | `project-lifecycle.service.test.ts` |
| I-9 | Only an empty project can be deleted; one that holds anything answers 409 `project_not_empty`. | FK refusal (errno 1451/1217) in `projects.service.ts` `deleteEmpty` | `project-lifecycle.service.test.ts` |

## Public API and contracts

All routes sit behind the global guard chain (SE-1) and are tenant-scoped by `:orgSlug`. Statuses:
201 create, 200 read, 204 delete, 400 `validation_failed`, 403 capability, 404 hidden, 409 version.

| Method path (prefix `/v1/organizations/:orgSlug`) | Capability | Success | File:line |
| --- | --- | --- | --- |
| GET `/projects` (`after`, `limit` ≤ 200) | `work.read` + relation filter | 200 | `projects.controller.ts:61-82` |
| GET `/projects/:projectId` | `work.read` | 200/404 | `projects.controller.ts:84-92` |
| POST `/projects` (`workspaceId`, `name`, `ownerUserId?`, `targetDate?`) | `project.create` + org switch | 201 | `projects.controller.ts:94-158` |
| GET/POST/PATCH/DELETE `/projects/:projectId/members` | `project.member.manage` + ceiling | 200/201 | `project-members.controller.ts:78,152,169,215,257` |
| GET `/projects/:projectId/summary` | `work.read` (finance block only with finance cap)| 200 | `project-summary.controller.ts:14` |
| GET `/projects/portfolio`, `/projects/health`, `/:projectId/health` | `work.read` | 200 | `portfolio.controller.ts:22`, `health.controller.ts:26,52` |
| `/:projectId/budget` (3), `/baselines` (6), `/phases` (5) | `work.read` / `project.manage` | 200/201 | `budget.controller.ts:107`, `baseline.controller.ts:72`, `phases.controller.ts:68` |
| `/:projectId/dependencies` (3), `/retro-notes` (3), `/status-updates` (2)| `project.manage` | 200/201 | `dependencies.controller.ts:47`, `retro-notes.controller.ts:50`, `status-updates.controller.ts:41` |
| `/:projectId/risk-register` (3), `/objectives` (3), tags (5) | `work.read` / `project.manage` | 200/201 | `risk-register.controller.ts:75`, `project-objectives.controller.ts:50`, `project-tags.controller.ts:31` |
| `/projects/custom-fields` + `/:projectId/custom-fields` (5) | `org.manage` / `project.manage` | 200/201 | `custom-fields.controller.ts:78,156` |
| `/objectives` (3), `/objectives/:id/key-results` (3), `/work-links` (3) | `work.read` / `project.manage` | 200/201 | `org-objectives.controller.ts:45`, `key-results.controller.ts:44`, `objective-work-links.controller.ts:37` |
| `/projects/templates` (3), `/projects/templates/packs` (2) | `project.manage` | 200/201 | `templates.controller.ts:202`, `template-packs.controller.ts:20` |
| `/projects/milestones/:milestoneId/links` (3) | `project.manage` | 200/201 | `milestone-links.controller.ts:42` |
| `/:projectId/favorite`, `/projects/favorites` (4) | `work.read` | 200/204 | `project-favorites.controller.ts:28,72` |
| GET `/:projectId/export?format=csv\|json` | `work.export` | 200 | `project-export.controller.ts:27` |
| GET `/:projectId/suggest-due` | `work.read` | 200 | `suggest-due.controller.ts:12` |

**Contracts (AR-10).** `e2e/contracts/api-web-shapes.ts` pairs `ProjectView` ↔ `ProjectSummary`
(`:1300`), project member (`:1323`), objective (`:1332`), internal risk (`:1342`), status update
(`:1353-1356`), template (`:1367`), portfolio (`:1384`), health (`:1394`), favourite (`:1520`),
tags (`:2167-2168`) with `Assert<Exact<…>>`.

**Exported services.** `PROJECTS_SERVICE` (`requireMayCreate`, `list`, `get`, `create`,
`createInTransaction`), `PROJECTS_REPOSITORY`, `PROJECT_MEMBERSHIPS_SERVICE`; `toProjectView`
(`projects.service.ts:291`).

**Events published (outbox).** `project.member_added.v1` (`project-memberships.service.ts:74`),
consumed by `apps/worker/src/consumers/collaboration-notices.ts:959`. **No event for
`project.created`**; the comment claiming the relay is "still not written"
(`projects.service.ts:210`) is stale — `api/platform`'s outbox exists (PRJ-6).

## Data: tables and migrations

| Table | Created (apps/api/migrations) | Keys / notes | Retention |
| --- | --- | --- | --- |
| `projects` | `0001_tenancy.sql:133`; target date `DATE` since 0012 | `fk_projects_workspace_tenant` (composite, `:151`); `fk_projects_owner` → `users` only (`:153`) | soft archive, no purge |
| `project_memberships` | `0001_tenancy.sql:157` | role per (project, user) | row deleted on leave |
| `project_objectives`, `org_objectives`, `objective_work_links`, `objective_key_results` | `0040`, `0046`, `0047`, `0087` | tenant-first PKs | project lifetime |
| `project_internal_risks`, `project_status_updates`, `project_templates`, `milestone_links` | `0088`, `0107`, `0106`, `0108` | | project lifetime |
| `project_tags`, `project_favorites` | `0137`, `0138` | | project lifetime |
| `project_budgets`, `project_phases`, `project_baselines` | `0160`, `0161`, `0162` | | project lifetime |
| `project_dependencies`, `project_custom_fields`, `project_retro_notes` | `0177`, `0178`, `0179` | | project lifetime |
| `project_budget_phases`, `budget_alert_events` | `0291_budget_burn.sql` | **`uq_budget_alert_events_dedupe` includes `created_at`** (AS-2 weak key) | grows (ST-6) |
| `project_baseline_items` | `0298_project_baseline_items.sql` | | baseline lifetime |
| `template_packs` | `0325_template_packs.sql` | | catalogue |

**Read but not owned:** `work_items`, `work_item_time_logs`, `work_item_schedule_stats` (work);
`project_milestones`, `project_risks`, `project_clients`, `client_organizations` (clients);
`memberships`, `workspaces` (tenancy); `users` (identity); `member_profiles`,
`person_allocations`, `person_capacity` (people); `approvals`. **Written but not owned:**
`conversation_memberships` (collaboration) on project leave (`project-memberships.repository.ts:401-408`).

**Expand/contract.** All listed migrations add tables or nullable columns (DA-6). Grants for each
table must be in `scripts/db/users.sql` in the same commit (DA-9; `common/database/grants.test.ts`).

## Permissions and tenant rules

**Guard chain (SE-1)** `Throttle → Session → CSRF → TenantContext → TwoStep → Capability`, global;
each route names one capability with `@RequireCapability` (table §3).

| Decision | Single owner | Notes |
| --- | --- | --- |
| May read this project? | `authorize()` in `packages/domain` with `Principal.projectIds` | applied **after** the page read (`projects.service.ts:146-170`); see PRJ-2 |
| May create a project? | `ProjectsService.requireMayCreate` (`:108-130`) | controller also calls `requireOrgPermission` with its own DB handle (`projects.controller.ts:141-144`) — twice, AR-6 |
| May grant this project role? | `project-members.controller.ts:124-134,188-190` (rank of `INTERNAL_ROLES`) | policy in a controller, not the service (AR-6/AR-8) |
| Tenant scope | `TenantDatabase.read/transaction` + repositories bind org (DA-12)| `projects.repository.ts:132,160` |
| Owner must be a member | **not checked** on POST `/projects` (`projects.controller.ts:125-134` says so) | PRJ-3; `api/work` checks it for items (`work-items.service.ts:1394`) |

Trust zones: staff only. Client principals reach project data through `api/clients` (portal
projections), not these routes; `list` filters a client to shared projects via
`Principal.projectIds` (`projects.service.ts:136-140`).

## Runtime, background work and failure modes

**Owned background work.** Budget burn: worker job `apps/worker/src/jobs/budget-burn-sweeper.ts`
(store `apps/worker/src/common/database/budget-burn-store.ts`), also run in the single Hostinger
app every 15 min under a named lock (`apps/server/scheduled-sweeps.mjs:303-333`). No other jobs.

| Failure | Behaviour today | Rule | Verdict |
| --- | --- | --- | --- |
| DB down | repository error propagates → 5xx (no catch-to-empty in services) | HT-1, HT-3 | correct |
| Retry of POST `/projects` after a lost response | **creates a second project**: no `IdempotencyReplayInterceptor` (only `work/time-logs` and `work/work-comments` use it) | HT-4 | gap (PRJ-5) |
| Two members create at once | independent inserts; no uniqueness on name | DA-1 | acceptable (names may repeat) |
| Page of 50 projects all unreadable | returns a short or empty page; web treats it as "the end" and reads only page one (`apps/web/src/lib/api/projects.ts:81-89`) | HT-3, DA-1 | gap (PRJ-2) |
| Audit or outbox not wired | `audit?`/`outbox?` are optional constructor args; a missing provider writes **nothing, silently** (`projects.service.ts:91-95`) | DA-11, AS-1 | risk (PRJ-7) |
| Two processes | no in-memory state in this module; budget burn runs under the sweep lock | RT-2, AS-4 | correct |
| Row times | 35 `current_timestamp` writes in non-test files (e.g. archive `projects.repository.ts:276`) | DA-10 | gap (PRJ-8) |

## UX rules for its screens

n/a — API module; its screens are owned by `web/org/projects`
(`apps/web/src/app/[orgSlug]/projects/PART.md`). Obligation to them (AR-9): return decisions
(e.g. `canManage`, `canExport`) as required fields. Today `ProjectView` carries none
(`projects.service.ts:40-80`), so the web derives them (WPJ-3 in that part).

## Standards that apply

| Rule | Today | Target |
| --- | --- | --- |
| AR-4 | SQL only in `*.repository.ts`; no service imports `drizzle-orm` (grep: no non-repository file imports `drizzle.js`) | keep |
| AR-5 / AR-7 | **breach**: 69 outside files import `ProjectsRepository`; this module reads clients/people/tenancy tables and deletes `conversation_memberships` | publish `ProjectsReadService` + events; first AR-5 target (VIEWS §4) |
| AR-6 | **breach**: `ProjectMembersController` injects three repositories and `TENANT_DATABASE` (`project-members.controller.ts:141-149`); `ProjectsController` injects `TENANT_DATABASE` (`projects.controller.ts:58`) | move into `ProjectMembershipsService` |
| AR-8 | create policy single-sourced in `requireMayCreate`; role ceiling lives in a controller | move ceiling into the service |
| AR-9 | `ProjectView` has no decision fields | add required `can*` fields |
| AR-10 | paired shapes for all main views (§3) | keep |
| HT-1 | 404 for unrelated project, 400 with field details, 201 on create | keep |
| HT-4 | POST `/projects` has no replay protection | `IdempotencyReplayInterceptor` |
| DA-1 | members PATCH uses `expectedRole` compare-and-swap (`project-members.controller.ts:104,215`) | name the anomaly per write path |
| DA-3, DA-12 | Drizzle with bound params; org bound from context | keep |
| DA-10 | `current_timestamp(3)` in 35 places | bound `Date` from the service clock |
| DA-11 | audit rows in the same transaction for create and membership | make `audit` non-optional |
| AS-1 / AS-2 | `project.member_added.v1` via outbox; budget alert dedupe key contains `created_at` (`0291_budget_burn.sql:83`) | business-key dedupe |
| SE-1 | every route has `@RequireCapability` | route census |
| PR-3 | short-page defect is the same class as work's (handled there by a bounded walk) | fix both the same way |
| IP-5 / IP-7 | repositories take a runner + context; factories in `projects.module.ts` | keep |

## How to change this part

- **New project-level route:** controller in `<feature>.controller.ts` under the
  `v1/organizations/:orgSlug/projects/:projectId/<feature>` prefix; one `@RequireCapability`;
  logic in `<feature>.service.ts`, SQL in `<feature>.repository.ts`, provider in
  `<feature>.module.ts` and registration in `projects.module.ts` (AR-4, AR-6, IP-7). Add the
  view pair to `e2e/contracts/api-web-shapes.ts` (AR-10).
- **Reading another context's data:** call that module's exported service; do not add another
  `schema.js` table import from tenancy/clients/people (AR-5/AR-7).
- **New table:** forward-only, MariaDB-safe migration in `apps/api/migrations/` (DA-4, DA-5),
  `organization_id` first in every key, grant in `scripts/db/users.sql` (DA-9).
- **A write that matters to someone else:** audit row and outbox event in the same
  `database.transaction` (DA-11, AS-1); never optional.
- **Rename/archive a project (missing today):** route on `ProjectsController`, service method with
  `version` compare-and-swap, audit `project.archived`, outbox `project.archived.v1`.
- Checks: `pnpm --filter @tmanage/api typecheck`, the co-located `*.test.ts`, then the db suites in §10.

## Tests and fitness checks

- Unit (co-located, 27 files): `projects.service.test.ts`, `project-memberships.service.test.ts`,
  `project-members.controller.test.ts`, `baseline-rules.test.ts`, `budget-burn.test.ts`,
  `health-reason.test.ts`, `summary-signals.test.ts`, `template-packs.catalog.test.ts`,
  `suggest-due.service.test.ts`, one `*.controller.test.ts` per feature controller.
- DB (`apps/api/test`): `proj-001-project-creation.db.test.ts`, `proj-001-repositories.db.test.ts`,
  `proj-001-objectives.db.test.ts`, `proj-010-portfolio.db.test.ts`,
  `projects-052-budget-burn.db.test.ts`, `projects-053-baselines.db.test.ts`,
  `projects-repository.db.test.ts`, `ten-004-invitation-projects.db.test.ts`,
  `wave10-r9-export-project-scope.db.test.ts`.
- E2E: `e2e/tests/projects-portfolio-journeys.spec.ts`; a11y `e2e/tests/a11y-audit.spec.ts:148,351-383`.
- Contract: `e2e/contracts/api-web-shapes.ts:1300-1394`.
- **Missing:** a db test that a 51st readable project is reachable (PRJ-2); an HT-4 replay test
  for POST `/projects`; an AR-6 import check for controllers.

## Open defects, decisions and risks

| Id | Class | Finding (verified at 3b7e4fa7) | Pri | Exit |
| --- | --- | --- | --- | --- |
| PRJ-1 | AR-5/AR-7 | 69 non-test files outside the module import `ProjectsRepository`; the module reads 9 foreign tables and deletes `conversation_memberships` (`project-memberships.repository.ts:401`) | P1 | read service + `project.member_removed.v1` consumed by collaboration |
| PRJ-2 | HT-3 / DA-1 | `list` filters after a single page (`projects.service.ts:146-170`, page 50 `projects.repository.ts:102`); web reads one page only (`apps/web/src/lib/api/projects.ts:81-89`), so >50 projects or a non-org-scoped reader silently loses projects; `ensureProjectForNewContent` may then create a duplicate (`apps/web/src/lib/api/projects.ts:126-138`) | P1 | bounded walk as in `work-items.service.ts:400-430`, or `projectIds` filter in SQL, plus web paging |
| PRJ-3 | DA-12 / SE | `ownerUserId` on POST is not checked for membership; FK is to `users` only (`0001_tenancy.sql:153`, comment `projects.controller.ts:125-134`) — another tenant's user can be named owner | P1 | reuse `requireOwnerIsMember` (`work-items.service.ts:1394`) |
| PRJ-4 | closed 2026-11-23 | rename, archive, restore and delete-when-empty routes added (fix lane C) | — | — |
| PRJ-5 | HT-4 | POST `/projects` and POST template instantiate have no idempotency replay | P2 | `IdempotencyReplayInterceptor` |
| PRJ-6 | AS-1 / doc | no `project.created.v1` event; stale comment `projects.service.ts:210` | P2 | emit the event; fix comment |
| PRJ-7 | DA-11 | `audit?`/`outbox?` optional: a wiring slip writes no audit row with no error (`projects.service.ts:91-95`) | P2 | required constructor args; module test asserts wiring |
| PRJ-8 | DA-10 | 35 `current_timestamp` row-time writes | P2 | bound `Date` |
| PRJ-9 | AS-2 | `uq_budget_alert_events_dedupe` contains `created_at` (ENGINEERING-STANDARD AS-2 row) | P2 | business key only |
| PRJ-10| AR-6 | repositories and DB handle in `ProjectMembersController` and `ProjectsController` | P2 | move into services |

DC classes present: DC-2 risk via missing AR-9 decisions (web derives them). DC-1, DC-3, DC-4,
DC-5, DC-6, DC-7 not present in this module.

## Glossary

| Term | Meaning |
| --- | --- |
| Target date | `forecast_at`: the date planned before the milestone plan is confirmed |
| Committed date | `committed_at`: the date promised once milestones are confirmed |
| Baseline | frozen snapshot of milestones/items to compare the live plan against |
| Portfolio | the cross-project read model (health, budget, client, owner) |
| Template pack | a curated set of project templates offered at project creation |
