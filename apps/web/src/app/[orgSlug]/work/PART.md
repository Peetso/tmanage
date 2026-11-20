---
part: web/org/work
kind: web-area
context: work-management
owner: implementation-lead
lifecycle: production
depends_on:
  [
    web-shared/api-client,
    web-shared/session,
    web-shared/work,
    web-shared/projects,
    api/work,
    api/work-views,
    api/requests,
    api/projects,
    package/domain,
  ]
provides_api: []
consumes_api:
  [
    '/v1/organizations/:orgSlug/work-items',
    '/v1/organizations/:orgSlug/work-items/:workItemId/*',
    '/v1/organizations/:orgSlug/work-items/bulk-transition',
    '/v1/organizations/:orgSlug/work-forms/*',
    '/v1/organizations/:orgSlug/projects (filter list)',
    '/v1/organizations/:orgSlug/work-views/* (api/work-views)',
    '/v1/organizations/:orgSlug/requests/* (api/requests)',
  ]
tables_owned: []
rules: [AR-3, AR-8, AR-9, AR-10, HT-1, HT-2, HT-3, HT-4, DA-1, SE-2, IP-9, IP-10, PR-3]
ux_rules:
  [UX-2, UX-3, UX-4, UX-5, UX-6, UX-7, UX-9, UX-10, UX-11, UX-14, UX-15, UX-16, UX-17, UX-18, UX-19, UX-23, UX-24]
last_verified_commit: 3b7e4fa70eb6facff3f1dccc65c0867f0707a0a6
last_verified_date: 2026-11-20
last_verified_by: Claude Opus 5.5 (lane H)
---

# web/org/work

Read this before changing any file under `apps/web/src/app/[orgSlug]/work/**` or the screens it
renders. Rule IDs refer to `docs/architecture/ENGINEERING-STANDARD.md` (AR, HT, DA, SE, PR),
`IMPLEMENTATION-PATTERNS.md` (IP) and `UI-UX-DESIGN-STANDARD.md` (UX). Every `file:line` was
checked at `3b7e4fa7`. Paths are relative to `apps/web/src/` unless they start with `apps/`,
`e2e/` or `docs/`.

## Purpose and bounded context

**What it is for.** Where staff see and move work: the work list and board (TM-10,
`docs/planning/22-SCREEN-BY-SCREEN-SPEC.md:124`), the work item detail (TM-13, `:141`) and its
sub-pages (activity, estimate, links, time logs), timeline (WK-04), calendar (WK-05), workload
(WK-06), saved views (WK-08), intake forms, and the client-request inbox, detail, triage and
aging (REQ-01 – REQ-03).

**Who uses it.** Internal members. Clients see their work in the portal, not here.

**Context map.** 15 thin `page.tsx` files (19–55 lines) over screens in `components/screens/**`
and shared parts `components/work/**` (`web-shared/work`). Data only through `lib/api/*` (AR-3).
Upstream: `api/work` (items), `api/work-views` (saved views, timeline/calendar reads),
`api/requests` (request screens), `api/projects` (project filter), `api/people` (workload).

| Route (under `/[orgSlug]/work`)                     | Screen                                    | Spec / Figma                                          |
| --------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| `/` (`?project=`, `?view=list\|board`, `?state=`)   | `screens/WorkListScreen` (+ `WorkBoardView`) | TM-10                                              |
| `[workItemId]`                                      | `screens/WorkItemDetailScreen`            | TM-13; phone Figma 407:6635 (`work/[workItemId]/page.tsx:7`); timer 574:32611 (`WorkItemDetailScreen.tsx:284`) |
| `[workItemId]/activity`, `estimate`, `links`, `time-logs` | `WorkItemActivityFeed`, `WorkItemEstimateScreen`, `WorkItemLinksScreen`, `WorkItemTimeLogScreen` | — |
| `timeline`, `calendar`, `workload`, `saved-views`   | `WorkTimelineScreen`, `WorkCalendarScreen`, `WorkWorkloadScreen`, `WorkSavedViewsScreen` | WK-04, WK-05, WK-06, WK-08 |
| `forms`                                             | `WorkFormsScreen`                         | —                                                     |
| `requests`, `requests/[requestId]`, `…/triage`, `requests/aging` | `RequestInboxScreen`, `RequestTriageScreen`, `RequestTriagePanelScreen`, `RequestAgingScreen` | REQ-01, REQ-02, REQ-03 |

## Domain model and invariants

No domain state of its own. The work item state machine is **imported** from `@tmanage/domain`
(`WorkItemDetailScreen.tsx:6`, `WorkListScreen.tsx:6`, `components/work/WorkViewsShell.tsx:6`), not
copied (AR-8); `pathToDone` walks it to offer "Mark done" (`WorkItemDetailScreen.tsx:165-171,370`).

| #   | Invariant                                                                                                                         | Where                                                         | Proof                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| I-1 | Filters, view and state live in the URL, so a reload or a shared link reopens the same list.                                      | `work/page.tsx:69-88`                                         | `apps/web/tests/fix3-work-views-stay-on-all-work.test.tsx` |
| I-2 | Every edit sends the `version` it read; a 409 reloads the item and is **never** retried (a retry would be the lost update).        | `WorkItemDetailScreen.tsx:219`, `WorkListScreen.tsx:133`      | `apps/web/tests/work-item-detail-edit.test.tsx`, `work-bulk-transition.test.tsx` |
| I-3 | Filters are inert until the projects query answers, so a pre-hydration choice is not silently lost.                               | `WorkListScreen.tsx:500-508`                                  | `apps/web/tests/work-flow.test.tsx`                     |
| I-4 | The list pages with the API cursor (`fetchNextPage`), so a short API page is not "the end".                                       | `WorkListScreen.tsx:226-233,1005`                             | `apps/web/tests/work-flow.test.tsx`                     |
| I-5 | The timeline has an accessible table alternative with the same rows; in Arabic time runs right to left.                          | `WorkTimelineScreen.tsx:102-105,560,1089`                     | `apps/web/tests/l5-work-knowledge-scenes-ar.test.tsx`  |
| I-6 | No workspace chrome before `signed-in` (SE-2).                                                                                    | `app/[orgSlug]/layout.tsx:27-34`                              | `e2e/tests/session-journeys.spec.ts`                   |

## Public API and contracts

The area publishes no API. Calls (typed by AR-10 pairs in `e2e/contracts/api-web-shapes.ts`):

| Client function (file)                                                        | Endpoint                                         | Pair                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------- |
| `listWorkItems`, `createWorkItem`, `updateWorkItem`, `transitionWorkItem` (`lib/api/work-items.ts:72-73,104,135,285`) | `…/work-items[/:id][/transitions]` | `_workItem` `:2020` |
| `lib/api/work-bulk-transition.ts`                                             | POST `…/work-items/bulk-transition`              | —                               |
| `lib/api/work-activity.ts`, `work-labels.ts`, `work-custom-fields.ts`, `work-item-recurrence.ts`, `work-relations-graph.ts`, `work-checklist-templates.ts`, `work-comment-mentions.ts` | per-item routes | `:2124`, `:2133`, `:2144-2147`, `:2156`, `:2072` |
| `lib/api/work-forms.ts`                                                       | `…/work-forms/*`                                 | forms pair                      |
| `lib/api/work-views.ts`, `workload-forecast.ts`, `working-calendar.ts`        | `api/work-views`, `api/people`                   | `_workloadForecast` `:1970`     |
| `lib/api/request-triage.ts`, `request-aging.ts`, `request-messages.ts`, `request-comments.ts`, `request-tags.ts` | `api/requests`              | request pairs                   |
| `listProjects` (`lib/api/projects.ts:81-89`)                                  | GET `…/projects` (filter options)                | `_project` `:1300`              |

Errors are rendered through `describeError` and `ApiRequestError`/`NetworkError`
(`WorkItemDetailScreen.tsx:314-321`) — one classifier (HT-2).

## Data: tables and migrations

n/a — a web area owns no tables. Client state: TanStack Query caches (`useInfiniteQuery` for the
list, `WorkListScreen.tsx:226`) and the last chosen view per page (`work/page.tsx:75`).

## Permissions and tenant rules

- **Tenant:** `[orgSlug]` is resolved by the API's `TenantContextGuard`; the org layout 404s an
  unknown slug (`app/[orgSlug]/layout.tsx:28`).
- **Capabilities are decided by the API** (`work.read/create/update/transition/delete`, see
  `apps/api/src/modules/work/PART.md` §3). The detail screen shows its actions without a decision
  from the server (no `can*` field exists on `WorkItemView`), so a viewer or a doer facing a
  supervisor rule learns it from a 403 (AR-9, WWK-4).
- **Audience (DC-6):** no staff/client branch in the org layout (`app/[orgSlug]/layout.tsx:19-36`);
  a client on `/[orgSlug]/work` gets the staff shell (shared finding, identity ID-3).
- Role literals: none found in the work screens (grep for `'owner'|'org_admin'|'workspace_admin'|'admin'`
  outside the overlay kind `{ kind: 'owner' }`, `WorkItemDetailScreen.tsx:414`, which is not a role).

## Runtime, background work and failure modes

All 15 pages are client components; live refresh comes from the realtime fan-out of
`work_item.*` events (`apps/web/tests/r48-work-live-refresh.test.tsx`). No background work.

| Failure                                  | Behaviour                                                                                                     | Rule         | Verdict        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------ | -------------- |
| List fails (list view)                   | danger alert + no rows; empty state suppressed while error (`WorkListScreen.tsx:551-565`)                     | HT-3, UX-23  | correct        |
| List fails (board view)                  | alert **and** the board rendered with no cards below it (`WorkListScreen.tsx:456-470`)                         | HT-3, UX-23  | ambiguous (WWK-3) |
| Item 404                                 | generic error alert with the API message — no 404 page (contrast `projects/[projectId]/page.tsx:39`)           | HT-1, UX-23  | gap (WWK-1)    |
| Item load error                          | alert without a retry action (`WorkItemDetailScreen.tsx:314-321`)                                             | UX-23        | gap (WWK-2)    |
| Version conflict                         | reload, no retry (I-2)                                                                                        | DA-1         | correct        |
| Lost response on "New task" / form submit| no `Idempotency-Key` → duplicate item possible                                                                | HT-4         | gap (API WRK-3)|
| Project filter > 50 projects             | `listProjects` reads page one only                                                                            | HT-3, PR-3   | gap (WWK-5)    |

## UX rules for its screens

**States (UX-23)** — from the screen sources:

| Screen                   | Loading                                  | Empty                                          | Error                                          |
| ------------------------ | ---------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| WorkListScreen           | `LoadingRegion` + skeleton (`:463-466`)  | `TeachingEmptyState` with "New task" (`:565-579`) | `InlineAlert` (`:458-461,551`)              |
| WorkItemDetailScreen     | `LoadingRegion` (`:307-311`)             | per block (files `:856-857`)                   | `InlineAlert`, no retry (`:314-321`)           |
| WorkTimelineScreen, WorkCalendarScreen, WorkWorkloadScreen, WorkSavedViewsScreen, WorkFormsScreen, WorkItemTimeLogScreen, RequestInboxScreen, RequestAgingScreen, RequestTriageScreen | yes | yes | yes |
| WorkItemEstimateScreen, RequestTriagePanelScreen | yes | **no empty branch found** | yes |
| WorkItemActivityFeed     | yes                                      | yes                                            | yes                                            |
| WorkItemLinksScreen (68 lines) | delegates to its child block; no own states | —                                         | —                                              |

**Copy (UX-15, UX-24).** All screens read `useT`/`useTOr`; key parity sampled en = ar:
`WorkListScreen.*` 91/91, `WorkItemDetailScreen.*` 63/63, `WorkTimelineScreen.*` 65/65
(`lib/i18n/messages/{en,ar}.json`). The detail error shows `item.error.message` — the API's own
English text — rather than a catalog string (`WorkItemDetailScreen.tsx:316-317`) (WWK-6).

**Arabic / RTL (UX-14).** Timeline uses logical insets and follows the reading direction for
pointer and arrow keys (`WorkTimelineScreen.tsx:102-103`, `displayLocaleDirection` `:39`); no
physical `margin/padding-left/right` in the work screens (grep hits were the variable names
`left`/`right` in comparators, `WorkListScreen.tsx:1140-1141`, `RequestInboxScreen.tsx:324`). The
a11y audit asserts `dir="rtl"` for `ar` (`e2e/tests/a11y-audit.spec.ts:550`).

**Accessibility (UX-3 – UX-9).** axe (WCAG 2.2 A/AA, en + ar) runs on the work list and the work
item (`e2e/tests/a11y-audit.spec.ts:146-147,357-358`). Keyboard: list rows have up/down
navigation and selection (`WorkListScreen.tsx:102,332,891`); scroll regions are focusable
(`:741`); board drag has a test (`apps/web/tests/fix3-drag-work.test.tsx`) — a non-pointer move
path for the board is **not verified**. **Not audited by axe:** timeline, calendar, workload,
saved views, forms, requests (4 routes), item sub-pages (4). VR (UX-18): no story for these
screens. Persona evaluation (UX-19): none found under `docs/`. Motion (UX-16): not verified.

## Standards that apply

| Rule         | How this area meets it, or the gap                                                       |
| ------------ | ---------------------------------------------------------------------------------------- |
| AR-3         | HTTP only via `lib/api/*`                                                                |
| AR-8         | state machine imported from `@tmanage/domain`, not copied                                |
| AR-9         | API returns no `can*`; web shows actions the API may refuse (WWK-4)                      |
| AR-10        | 15 work pairs used                                                                       |
| HT-1, HT-2   | one error classifier; 404 not distinguished on the item page (WWK-1)                     |
| HT-3         | no `catch → []/null` in the 15 screens (grep: 0); board-on-error ambiguity (WWK-3)       |
| HT-4         | create and form submit carry no idempotency key                                          |
| DA-1         | version token sent on every edit; 409 not retried                                        |
| SE-2         | `SignedInGate` in the org layout                                                         |
| IP-9, IP-10  | all pages client components; data via TanStack Query (no fetch-in-effect in pages)       |
| PR-3         | the first-page-only `listProjects` class is shared with `web/org/projects` (WPJ-2)       |
| UX-2, UX-3   | signifiers: "Mark done" only when a path to done exists (`WorkItemDetailScreen.tsx:370,385`) |
| UX-4 – UX-7  | axe on 2 of 15 routes                                                                    |
| UX-9         | native `<fieldset>/<legend>/<select>/<label>` filters (`WorkListScreen.tsx:508-515`)     |
| UX-10, UX-24 | teaching empty state with help link (`:567-579`)                                         |
| UX-11        | `tm-*` classes, token CSS; phone CSS `styles/phone/work-item.css`                        |
| UX-14, UX-15 | logical layout; one raw API message (WWK-6)                                              |
| UX-16, UX-17 | skeletons on load; motion not verified                                                   |
| UX-18, UX-19 | not met                                                                                  |
| UX-23        | most screens complete; gaps listed above                                                 |

## How to change this part

- **New work view or page:** `work/<name>/page.tsx` (thin, `use(params)`, URL holds the filters),
  a screen in `components/screens/`, a client in `lib/api/`, the contract pair (AR-10).
- **Any action on an item:** send `version`, map 409 to "reload, someone changed it", never
  retry automatically (DA-1); unsafe creates send `Idempotency-Key` once the API accepts it (HT-4).
- **State logic:** import from `@tmanage/domain`; do not add a state list or transition table in
  the web (AR-8).
- Design in Figma first (UX-1, UX-22); copy in all 8 catalogs; add the route to
  `e2e/tests/a11y-audit.spec.ts` for both locales.
- Checks: `pnpm --filter @tmanage/web typecheck`, `apps/web/tests/work-*`, the a11y spec.

## Tests and fitness checks

- Web (`apps/web/tests/`): `work-flow.test.tsx`, `work-board-view.test.tsx`,
  `work-bulk-transition.test.tsx`, `work-item-detail-edit.test.tsx`,
  `work-item-activity-feed.test.tsx`, `work-item-attachment-versions.test.tsx`,
  `work-attachments-upload.test.ts`, `work-calendar-range.test.tsx`,
  `work-comments-mention.test.tsx`, `work-activity-presentation.test.ts`,
  `fix3-drag-work.test.tsx`, `fix3-work-views-stay-on-all-work.test.tsx`,
  `r48-work-live-refresh.test.tsx`, `new-work-capture.test.tsx`, `c4-work-item-files-not-scanned.test.tsx`,
  `client-requests-flow.test.tsx`, `request-aging-flow.test.tsx`, `request-messages.test.tsx`,
  `l5-work-knowledge-scenes-ar.test.tsx`.
- E2E: `e2e/tests/work-journeys.spec.ts`, `work-forms-journeys.spec.ts`,
  `insights-workload-journeys.spec.ts`; a11y `e2e/tests/a11y-audit.spec.ts`.
- Contract: `e2e/contracts/api-web-shapes.ts:2020-2156`.
- **Missing:** item-page 404 test; axe for 13 routes; keyboard-only board move journey.

## Open defects, decisions and risks

| Id    | Class        | Finding (verified at 3b7e4fa7)                                                                                         | Pri | Exit                                                   |
| ----- | ------------ | ---------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------ |
| WWK-1 | HT-1 / UX-23 | unknown or hidden work item shows a generic error alert, not the 404 page (`work/[workItemId]/page.tsx` has no `notFound()`) | P2  | same pattern as `projects/[projectId]/page.tsx:33-39` |
| WWK-2 | UX-23        | item load error has no retry (`WorkItemDetailScreen.tsx:314-321`)                                                      | P2  | retry action                                           |
| WWK-3 | HT-3         | board view renders an empty board under the error alert (`WorkListScreen.tsx:456-470`)                                 | P2  | render the board only on success                       |
| WWK-4 | AR-9 / DC-2  | actions shown without server decisions; 403 is the first signal                                                        | P2  | `can*` fields from `api/work` (WRK-5)                  |
| WWK-5 | HT-3 / PR-3  | project filter built from page one of `listProjects` (`WorkListScreen.tsx:195`)                                        | P1  | page through (with API PRJ-2)                          |
| WWK-6 | UX-15        | raw API message in the item error (`WorkItemDetailScreen.tsx:316-317`)                                                 | P2  | catalog text by error code                             |
| WWK-7 | DC-6         | client principal on a staff URL gets the staff shell                                                                    | P1  | audience-aware layout (identity ID-3)                  |
| WWK-8 | UX-4 / UX-18 | axe on 2 of 15 routes; no VR baselines; board keyboard move not verified                                               | P2  | extend audit + stories + journey                       |
| WWK-9 | IP-9         | 15/15 pages are client components and pass `FIXTURE_ORGANIZATION_NAME`                                                | P2  | server page reads the org name                         |

## Glossary

| Term        | Meaning (AR from `lib/i18n/messages/ar.json`)                                              |
| ----------- | ------------------------------------------------------------------------------------------ |
| Backlog     | not yet planned — "قائمة الانتظار" (`WorkListScreen.stateBacklog`, `:7037`)               |
| Blocked     | stopped, with a reason and an ask — "متوقفة" (`WorkListScreen.stateBlocked`, `:7040`)      |
| Internal review | waiting for a supervisor — "مراجعة داخلية" (`WorkListScreen.stateInternalReview`, `:7041`) |
| Done        | completed — "مكتملة" (`WorkListScreen.stateDone`, `:7042`)                                 |
