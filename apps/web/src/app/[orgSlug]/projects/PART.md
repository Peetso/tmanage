---
part: web/org/projects
kind: web-area
context: work-management
owner: implementation-lead
lifecycle: production
depends_on:
  [
    web-shared/api-client,
    web-shared/session,
    web-shared/projects,
    web-shared/clients,
    api/projects,
    api/work,
    api/clients,
    package/domain,
  ]
provides_api: []
consumes_api:
  [
    '/v1/organizations/:orgSlug/projects',
    '/v1/organizations/:orgSlug/projects/:projectId',
    '/v1/organizations/:orgSlug/projects/:projectId/{summary,members,objectives,baselines,risk-register,export}',
    '/v1/organizations/:orgSlug/projects/{portfolio,tags,templates,templates/packs}',
    '/v1/organizations/:orgSlug/projects/:projectId/{milestones,risks,deliverables,portal-access-log} (api/clients)',
    '/v1/organizations/:orgSlug/me (permission matrix)',
  ]
tables_owned: []
rules: [AR-3, AR-8, AR-9, AR-10, HT-2, HT-3, HT-4, SE-2, IP-9, IP-10, PR-3]
ux_rules:
  [UX-2, UX-4, UX-5, UX-6, UX-7, UX-9, UX-10, UX-11, UX-14, UX-15, UX-17, UX-18, UX-19, UX-23, UX-24]
last_verified_commit: 3b7e4fa70eb6facff3f1dccc65c0867f0707a0a6
last_verified_date: 2026-11-20
last_verified_by: Claude Opus 5.5 (lane H)
---

# web/org/projects

Read this before changing any file under `apps/web/src/app/[orgSlug]/projects/**` or the screens
it renders. Rule IDs refer to `docs/architecture/ENGINEERING-STANDARD.md` (AR, HT, SE, PR),
`IMPLEMENTATION-PATTERNS.md` (IP) and `UI-UX-DESIGN-STANDARD.md` (UX). Every `file:line` was
checked at `3b7e4fa7`. Paths are relative to `apps/web/src/` unless they start with `apps/`,
`e2e/` or `docs/`.

## Purpose and bounded context

**What it is for.** The staff screens for one project and for projects as a whole: the project
overview (TM-03, `docs/planning/22-SCREEN-BY-SCREEN-SPEC.md:87`), the portfolio (the de-facto
project list), new project, templates, tags, and the per-project sub-screens (members and roles
ADM-02, objectives, milestones, client risks, internal risk register, baselines, iterations,
allocations, deliverables and approval records, GitHub links, portal access log).

**Who uses it.** Internal members of a workspace (owner, admins, managers, members). Clients use
the portal (`app/[orgSlug]/portal`), never these routes.

**Context map.** A thin route layer (18 `page.tsx`, 22–49 lines each) over screens in
`components/screens/**` and `components/projects/**` (part `web-shared/projects`); data comes only
over HTTP through `lib/api/*` (AR-3). Upstream API parts: `api/projects`, `api/clients`
(milestones, risks, deliverables, portal log), `api/work`, `api/people` (allocations),
`api/iterations`.

| Route (under `/[orgSlug]/projects`)                                   | Screen component                                 | Spec id / Figma            |
| --------------------------------------------------------------------- | ------------------------------------------------ | -------------------------- |
| `[projectId]` (`?view=activity`)                                      | `screens/ProjectOverviewScreen`                  | TM-03; Figma 739:40334, AR 739:40873 (`ProjectOverviewScreen.tsx:59`) |
| `portfolio`                                                           | `screens/ProjectPortfolioScreen`                 | navigation target (`components/shell/navigation.ts:194`) |
| `new`                                                                 | `screens/FirstProjectScreen` (mode `new`)        | ON-03 form reused          |
| `templates`, `tags`                                                   | `ProjectTemplatesScreen`, `ProjectTagsScreen`    | —                          |
| `[projectId]/members`                                                 | `MembersAndRolesScreen`                          | ADM-02                     |
| `[projectId]/objectives`, `milestones`, `risks`, `risk-register`      | `ProjectObjectivesScreen`, `ProjectMilestonesScreen`, `ProjectRisksScreen`, `ProjectRiskRegisterScreen` | — |
| `[projectId]/baselines`, `iterations`, `allocations`                  | `ProjectBaselineView`, `ProjectIterationsScreen`, `ProjectAllocationsScreen` | — |
| `[projectId]/deliverables`, `deliverables/[deliverableId]`, `…/approvals/[approvalId]/record` | `DeliverablesScreen`, `DeliverableDetailScreen`, `approvals/ApprovalCertificate` | — |
| `[projectId]/github`, `portal-access-log`                             | `ProjectGithubScreen`, `PortalAccessLogScreen`   | —                          |

There is **no `projects/page.tsx`**: `/[orgSlug]/projects` is a 404, yet
`components/screens/AdminPublicLinksScreen.tsx:406` links to it (WPJ-1).

## Domain model and invariants

The area holds no domain state; it renders API views. Invariants it must keep:

| #   | Invariant                                                                                                   | Where                                                                       | Proof                                                   |
| --- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------- |
| I-1 | No workspace chrome renders before the session is `signed-in` (SE-2).                                       | `app/[orgSlug]/layout.tsx:27-34` (`requestWorkspaceGate`, `SignedInGate`)   | `e2e/tests/session-journeys.spec.ts`                   |
| I-2 | An unknown project id renders the 404 page, not an empty overview; 404 is never retried.                    | `projects/[projectId]/page.tsx:33-39`                                        | `apps/web/tests/b15-project-not-found.test.ts`         |
| I-3 | The overview reads the project once: page and screen share the query key `['project', org, id]`.            | `projects/[projectId]/page.tsx:34`, `components/screens/ProjectOverviewScreen.tsx:87-90` | `apps/web/tests/project-overview-screen.test.tsx` |
| I-4 | The sample organisation name ("Northstar Studio") is never shown; the shell shows the real name or nothing. | `lib/use-organization-names.ts:51-62`                                       | ACC-14 tests (shell)                                   |
| I-5 | Names a user typed are isolated for bidi (`<bdi>`).                                                         | `ProjectOverviewScreen.tsx:120-124`                                         | `apps/web/tests/l5-work-knowledge-scenes-ar.test.tsx` (pattern) |

## Public API and contracts

The area publishes no API. Calls it makes (all through `lib/api/*`, typed by the AR-10 pairs in
`e2e/contracts/api-web-shapes.ts`):

| Client function (file)                                          | Endpoint                                      | Contract pair                      |
| --------------------------------------------------------------- | --------------------------------------------- | ---------------------------------- |
| `getProject`, `listProjects`, `createProject` (`lib/api/projects.ts:81-89`) | GET/POST `…/projects[/:id]`        | `_project` `:1300`                 |
| `getProjectSummary` (`lib/api/project-summary.ts`)              | GET `…/:projectId/summary`                    | summary pair                       |
| `lib/api/project-portfolio.ts`, `project-health.ts`             | GET `…/projects/portfolio`, `/health`         | `_projectPortfolio` `:1384`, `_projectHealth` `:1394` |
| `lib/api/project-members.ts`                                    | `…/:projectId/members`                        | `_projectMember` `:1323`           |
| `lib/api/project-objectives.ts`, `project-risk-register.ts`, `project-status-updates.ts`, `project-templates.ts`, `project-tags.ts` | per feature | `:1332`, `:1342`, `:1353`, `:1367`, `:2167` |
| `lib/api/project-milestones.ts`, `deliverables.ts`, `project-client.ts` | `api/clients` routes                   | `_projectMilestone` `:1288`, `_projectClient` `:1293` |
| `readOrganizationMe` (`lib/api/permission-matrix.ts`)           | GET `…/me`                                    | —                                  |

Errors are classified by `lib/api/errors` / `describe-error`; `isApiNotFound` decides 404
(`lib/api/not-found`), so no screen writes its own `status >= 500` test (HT-2).

## Data: tables and migrations

n/a — a web area owns no tables. Query cache keys are the only client data: `['project', org, id]`,
`projectSummaryQueryKey(org, id)` (`ProjectOverviewScreen.tsx:92`), `['organization-me', org]`
(`:98`). They must stay shared between page and screen (I-3).

## Permissions and tenant rules

- **Tenant:** the `[orgSlug]` segment is the claim the API's `TenantContextGuard` resolves
  (`projects/[projectId]/page.tsx:16-18`); the gate 404s a slug that is not a workspace
  (`app/[orgSlug]/layout.tsx:28`).
- **Capabilities are decided by the API.** `new` relies on `@RequireCapability('project.create')`;
  the "New project" buttons are shown only for roles whose ceiling holds it
  (`projects/new/page.tsx:13-14`, `components/projects/NewProjectLink.tsx`).
- **Derived in the web (AR-9/DC-2):** the client-company link on the overview is shown when
  `me.capabilities.includes('org.manage') ?? false` (`ProjectOverviewScreen.tsx:101`): the web
  re-decides who may open a client from a raw capability list (WPJ-3).
- **Audience (DC-6):** the org layout has no staff/client branch (`app/[orgSlug]/layout.tsx:19-36`);
  a client principal who opens a staff URL gets the staff shell and API refusals, because the
  session answer has no `audience` (identity ID-3).

## Runtime, background work and failure modes

All 18 pages are client components (`'use client'` in every `page.tsx`): data loads after
hydration with TanStack Query. No background work.

| Failure                                   | Behaviour                                                                                                 | Rule         | Verdict           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------ | ----------------- |
| API 404 on project                        | `notFound()` (`projects/[projectId]/page.tsx:39`)                                                         | HT-1, UX-23  | correct           |
| API 5xx / network on overview             | summary blocks render `state="error"` with retry (`ProjectOverviewScreen.tsx:200-203`)                   | HT-3, UX-23  | correct           |
| Organisation list fails                   | header name collapses to `''` (`lib/use-organization-names.ts:51-62`) — unknown shown as blank            | HT-3         | minor (WPJ-6)     |
| More than 50 projects                     | `listProjects` reads only page one (`lib/api/projects.ts:81-89`); portfolio, filters and `ensureProjectForNewContent` (`:126-138`) miss the rest | HT-3, PR-3 | gap (WPJ-2, API PRJ-2) |
| Double submit on "Create project"         | no `Idempotency-Key`                                                                                      | HT-4         | gap (API PRJ-5)   |

## UX rules for its screens

**States (UX-23)** — counted in the screen sources (grep of `isPending|Loading|Skeleton`,
`isError|ErrorState`, `EmptyState|empty`):

| Screen                      | Loading                                   | Empty                                        | Error                                      |
| --------------------------- | ----------------------------------------- | -------------------------------------------- | ------------------------------------------ |
| ProjectOverviewScreen       | `OverviewBlocks state="loading"` (`:200`) | `deliveryEmpty="work"` (`:208`)              | `state="error"` + retry (`:202-203`)       |
| ProjectPortfolioScreen      | `:192`                                    | `TeachingEmptyState` (`:199-214`)            | `:186`                                     |
| ProjectBaselineView, ProjectIterationsScreen, ProjectRiskRegisterScreen, ProjectTemplatesScreen, ProjectTagsScreen, ProjectGithubScreen, PortalAccessLogScreen, MembersAndRolesScreen, DeliverablesScreen, ProjectMilestonesScreen, ProjectRisksScreen | yes | yes | yes |
| ProjectAllocationsScreen, ProjectObjectivesScreen, DeliverableDetailScreen, ApprovalCertificate | yes | **no empty branch found** | yes |

**Writing and copy (UX-15, UX-24).** Copy comes from `useT`/`useTOr` and the catalogs
`lib/i18n/messages/{ar,de,en,es,fr,pt-BR,ur,zh-CN}.json`; key parity sampled en = ar for
`ProjectOverviewScreen.*` (14/14) and `ProjectPortfolioScreen.*` (22/22). **Literal English in a
route:** `signedInAs="You"` (`projects/new/page.tsx:24`) (WPJ-4).

**Arabic / RTL (UX-14).** Overview has an Arabic Figma frame (739:40873); user names wrapped in
`<bdi>`; no physical `left/right` CSS found in the project screens (grep). The a11y audit runs
`en` and `ar` with `dir="rtl"` asserted (`e2e/tests/a11y-audit.spec.ts:239,550`).

**Accessibility (UX-4 – UX-9).** axe at WCAG 2.2 A/AA runs on: portfolio
(`e2e/tests/a11y-audit.spec.ts:148,351`), overview (`:355`), deliverables (`:365`), deliverable
detail (`:370`), members (`:383`). **Not verified:** templates, tags, objectives, milestones,
risks, risk register, baselines, iterations, allocations, github, portal log, new project. Target
size (UX-5), focus (UX-6) and contrast (UX-7) are covered only where axe runs. VR baselines
(UX-18): no Storybook story renders these screens (grep of `*.stories.tsx`). Persona evaluation
(UX-19): none found for this area under `docs/`.

**Design consistency (UX-2).** Two risk screens exist side by side — `risks` (client-facing
risks, `api/clients`) and `risk-register` (internal) — with different names for the same idea;
the tabs show only `risks` (`components/projects/ProjectTabs.tsx`) (WPJ-7).

## Standards that apply

| Rule        | How this area meets it, or the gap                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| AR-3        | only `lib/api/*` over HTTP; no `apps/api` import (grep)                                                 |
| AR-8, AR-9  | capability derived in web for the client link (WPJ-3); API returns no `can*` fields (API PRJ, AR-9)     |
| AR-10       | every view used is paired in `e2e/contracts/api-web-shapes.ts`                                          |
| HT-2, HT-3  | shared classifier; no `catch → []/null` in the screens (grep of the 18 screens: 0)                      |
| HT-4        | create has no idempotency key                                                                           |
| SE-2        | `SignedInGate` in the org layout                                                                         |
| IP-9        | **all pages are client components**; data waits for hydration                                           |
| IP-10       | queries through TanStack Query, no fetch-in-effect in the pages                                         |
| PR-3        | the first-page-only class (WPJ-2) must be fixed in both API and every `listProjects` caller             |
| UX-2        | two risk screens (WPJ-7)                                                                                |
| UX-4 – UX-7 | axe on 6 of 18 routes                                                                                   |
| UX-9        | native `<select>`, `<fieldset>`, `<legend>` in forms (pattern from shared components)                  |
| UX-10, UX-24| teaching empty states with help link (`ProjectPortfolioScreen.tsx:200-214`)                            |
| UX-11       | styles via `tm-*` classes and tokens; no hex literal found in the pages                                |
| UX-14, UX-15| catalogs + `<bdi>`; one literal (WPJ-4)                                                                 |
| UX-17       | skeletons on load; client-only pages delay first data (IP-9)                                            |
| UX-18, UX-19| not met for these screens                                                                               |
| UX-23       | four states on most screens; 4 lack an empty branch                                                     |

## How to change this part

- **New project sub-screen:** `projects/[projectId]/<name>/page.tsx` (thin: `use(params)`, render
  one screen), screen in `components/screens/<Name>Screen.tsx`, client in `lib/api/<name>.ts`, the
  API/web pair in `e2e/contracts/api-web-shapes.ts` (AR-10). Add the tab in
  `components/projects/ProjectTabs.tsx` if it belongs in the project header.
- Design in Figma first (Peter rule; UX-1, UX-22), then build; copy keys in all 8 catalogs.
- Every query: render loading, empty, error-with-retry and unknown (UX-23); never default a
  decision (`?? false`) — wait for it (AR-9).
- Add the route to `e2e/tests/a11y-audit.spec.ts` (both locales).
- Checks: `pnpm --filter @tmanage/web typecheck`, `apps/web/tests/*project*`, the a11y spec.

## Tests and fitness checks

- Web unit/integration (`apps/web/tests/`): `project-flow.test.tsx`,
  `project-overview-screen.test.tsx`, `project-portfolio.test.tsx`, `project-milestones.test.tsx`,
  `project-objectives.test.tsx`, `project-templates-dialog.test.tsx`,
  `project-export-import-link.test.tsx`, `b15-project-not-found.test.ts`,
  `new-project-client-picker.test.tsx`, `new-project-link.test.ts`, `deliverables-flow.test.tsx`,
  `fixlive-burn-and-portal-project.test.tsx`, `r38-g4-invite-projects.test.tsx`,
  `m3-work-templates-ar.test.tsx`.
- E2E: `e2e/tests/projects-portfolio-journeys.spec.ts`; a11y (en + ar) `e2e/tests/a11y-audit.spec.ts`.
- Contract: `e2e/contracts/api-web-shapes.ts:1288-1394,2167-2168`.
- **Missing:** a link checker for internal hrefs (would catch WPJ-1); axe on the 12 unaudited
  routes; VR stories.

## Open defects, decisions and risks

| Id    | Class        | Finding (verified at 3b7e4fa7)                                                                                                       | Pri | Exit                                                        |
| ----- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------ | --- | ----------------------------------------------------------- |
| WPJ-1 | broken link  | `/[orgSlug]/projects` has no page; `AdminPublicLinksScreen.tsx:406` links to it                                                       | P1  | `projects/page.tsx` redirecting to `portfolio`, or fix href |
| WPJ-2 | HT-3 / PR-3  | `listProjects` reads page one only (`lib/api/projects.ts:81-89`); with API PRJ-2, projects silently disappear past 50                | P1  | page through, after the API fix                             |
| WPJ-3 | DC-2 / AR-9  | `capabilities.includes('org.manage') ?? false` decides the client link (`ProjectOverviewScreen.tsx:101`)                             | P2  | API returns `canOpenClient`                                 |
| WPJ-4 | UX-15        | literal `signedInAs="You"` (`projects/new/page.tsx:24`)                                                                              | P2  | catalog key                                                 |
| WPJ-5 | DC-6         | no audience branch in the org layout; client on a staff URL sees the staff shell                                                     | P1  | identity `audience` + layout redirect to portal             |
| WPJ-6 | HT-3         | organisation name blank when the org list fails (`lib/use-organization-names.ts:51-62`)                                              | P2  | render unknown with retry                                   |
| WPJ-7 | UX-2         | `risks` and `risk-register` — two screens for risks, one in the tabs                                                                 | P2  | design review (Fable) decides one model                     |
| WPJ-8 | IP-9 / UX-17 | 16 of 18 pages pass `FIXTURE_ORGANIZATION_NAME`; all are client components                                                           | P2  | server page reads org name; client leaves only              |
| WPJ-9 | UX-4 / UX-18 | axe on 6 of 18 routes; no VR baselines                                                                                               | P2  | extend the audit list and stories                           |

## Glossary

| Term          | Meaning (AR as in `lib/i18n/messages/ar.json`)                                        |
| ------------- | ------------------------------------------------------------------------------------- |
| Portfolio     | all projects with health and budget — "المحفظة" (`ProjectTabs.portfolio`, `:652`)    |
| Deliverable   | a piece of work shown to the client for approval                                       |
| Baseline      | frozen plan to compare against — "الخطط المرجعية للمراحل" (`ProjectBaselineView.title`, `:6001`) |
| Risk register | internal list of project risks — "سجل المخاطر" (`ProjectRiskRegisterScreen.title`, `:3165`) |
