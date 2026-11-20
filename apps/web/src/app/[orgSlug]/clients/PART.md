---
part: web/org/clients
kind: web-area
context: client-portal
owner: implementation-lead
lifecycle: production
depends_on:
  [
    web-shared/screens,
    web-shared/clients,
    web-shared/shell,
    web-shared/session,
    web-shared/api-client,
    web-shared/help,
    package/ui,
    package/domain,
  ]
provides_api: []
consumes_api:
  [
    '/v1/organizations/:orgSlug/client-organizations/*',
    '/v1/organizations/:orgSlug/client-memberships/*',
    '/v1/organizations/:orgSlug/client-organizations/:id/summary',
    '/v1/organizations/:orgSlug/contacts/import-preview',
    '/v1/organizations/:orgSlug/contacts/import-file',
    '/v1/organizations/:orgSlug/invitations/*',
    '/v1/organizations/:orgSlug/me',
  ]
tables_owned: []
rules: [AR-3, AR-8, AR-9, AR-10, HT-2, HT-3, HT-5, IP-9, IP-10, DC-2, DC-6, QM-2]
ux_rules: [UX-2, UX-4, UX-5, UX-6, UX-9, UX-14, UX-15, UX-17, UX-18, UX-19, UX-23, UX-24]
last_verified_commit: 3b7e4fa70eb6facff3f1dccc65c0867f0707a0a6
last_verified_date: 2026-11-20
last_verified_by: Claude Opus 5.5 (lane H)
---

# web/org/clients

Read this before changing any file under `apps/web/src/app/[orgSlug]/clients/**` or the screens
it renders. Rule IDs refer to `docs/architecture/ENGINEERING-STANDARD.md`,
`IMPLEMENTATION-PATTERNS.md` (IP) and `UI-UX-DESIGN-STANDARD.md` (UX). Every `file:line` was
checked at `3b7e4fa7`. Paths under `apps/web/src/` are written from `src/`.

## Purpose and bounded context

**What it is for.** The staff side of the **Client Portal** context (VIEWS §4): the agency's
list of client companies and their invitations, one page per client company (overview,
projects, people, activity), and importing contacts as clients. It is the web face of
`api/clients` (staff routes) and of the contact import in `api/people`.

**Who uses it.** Owners and admins (`org.manage`, `client_member.manage`); members reach a
company page from links. Client principals must **never** see it: they belong in
`/[orgSlug]/portal` (DC-6).

**Route files (thin, all `'use client'`):**

- `/[orgSlug]/clients` → `ClientsScreen` (`app/[orgSlug]/clients/page.tsx:1-16`).
- `/[orgSlug]/clients/[clientOrganizationId]?view=overview|projects|people|activity&health=at-risk`
  → `ClientCompanyScreen` (`[clientOrganizationId]/page.tsx:9-33`; view parsing
  `components/overview/overview-links.ts:101-103`, unknown values fall back to `overview`).
- `/[orgSlug]/clients/import` → `ContactsImportScreen` (`import/page.tsx:1-18`).

Every page passes `FIXTURE_ORGANIZATION_NAME` ("Northstar Studio", `lib/fixtures.ts:31`) as the
organization name; the shell replaces it with the real name and shows nothing while loading,
never the fixture (`lib/use-organization-names.ts:52-67`).

**Shell and gates.** The layout `app/[orgSlug]/layout.tsx` runs the server workspace gate
(not-found / sign-in redirect) and `SignedInGate`; inside `AppShell` the client-side gates run
`SupportSessionEndedGate → MembershipGoneGate → ClientPortalGate → WorkspaceSuspendedGate`
(`components/shell/AppShell.tsx:392-399`).

## Domain model and invariants

The area owns no domain model; it renders the API's views (`ClientOrganization`,
`ClientMembership`, invitation summaries, the client summary). Invariants it must keep:

- **I-1** A client principal is sent to `/[orgSlug]/portal` and never shown the staff shell
  (DC-6) · `ClientPortalGate` `components/shell/ClientPortalGate.tsx:24-33`. **Holds only once
  the audience is loaded**: while `useOrganizationAudience` is `undefined` the gate renders its
  children (`:31-33`, `lib/use-organization-names.ts` `useOrganizationAudience`), and
  `MembershipGoneGate` does the same while not loaded (`components/shell/MembershipGoneGate.tsx:53`).
  The staff screen therefore mounts, and its queries start, before the redirect.
- **I-2** Who may act is the server's capability answer, interpreted once: `useShellCapability`
  → `roleMayUse` → `hasCapability` from `@tmanage/domain` (`components/shell/use-shell-capability.ts:18-40`,
  `lib/role-capability.ts:12-20`). No role literal in these screens (grep: none).
- **I-3** A failed list is an error, not "no clients": `organizations.isError` renders a danger
  alert, and the teaching empty state appears only on `isSuccess && length === 0`
  (`components/screens/ClientsScreen.tsx:322-341`).
- **I-4** The client page is one read (`getClientSummary`, ONEPAGE) plus the company and
  projects; each has its own pending/error branch (`ClientCompanyScreen.tsx:228-273`).

## Public API and contracts

n/a — a web area exposes no API. It calls (through `lib/api/*`, AR-3):

- `lib/api/clients.ts`: `listClientOrganizations`, `getClientOrganization`,
  `createClientOrganization`, `archiveClientOrganization`, `listClientMemberships`,
  `listClientPeople`, `listClientProjects`, `listClientInvitations`.
- `lib/api/client-summary.ts`: `getClientSummary` → `GET …/client-organizations/:id/summary`
  (`client-summary.ts:94`).
- `lib/api/contact-import.ts`: `previewContactImport`, `importContacts` → `…/contacts/<leaf>`
  (`contact-import.ts:73-74`), served by `apps/api/src/modules/people/contact-suggestions.controller.ts:28-30`.
- `lib/api/invitations.ts` (resend), `lib/api/permission-matrix.ts` `readOrganizationMe`.

Shapes are paired in `e2e/contracts/api-web-shapes.ts` (`_clientOrganization`,
`_clientOrganizationView` `:1296-1297`; `_projectClient` `:1293`) (AR-10).

## Data: tables and migrations

n/a — web area; no tables. Client-side cache keys: `['clients', orgSlug]` (refresh after
mutations, `ClientCompanyScreen.tsx:125`), `['organization-me', orgSlug]` (`:120`),
`['shell', 'organizations']` (capabilities). Layout preference stored per org under
`clients:<orgSlug>` (`ClientsScreen.tsx:132-135`).

## Permissions and tenant rules

- **Server first.** The server gate (`lib/workspace-gate-request.ts:10-17`) decides not-found vs
  sign-in from the slug and a session hint; the API authorizes every call. The web only decides
  what to **offer**.
- **Offer rules:** "Invite client" and the empty-state action need `org.manage`
  (`ClientsScreen.tsx:333`); the finance part of a company page needs `finance.view` from
  `readOrganizationMe` (`ClientCompanyScreen.tsx:119-123`).
- **Fails closed, not unknown:** `useShellCapability` answers "no" until the role is known
  (`use-shell-capability.ts:13-15`) and `mayViewFinance` is `?? false` (`ClientCompanyScreen.tsx:123`).
  This hides actions while loading and **also when the read fails** — AR-9 asks for an unknown
  state instead of a default.
- **Trust zone:** staff only. Client principals are redirected (I-1); the API also refuses them
  (role ceilings, `packages/domain/src/policies/authorize.ts:303-326`).

## Runtime, background work and failure modes

Client components with TanStack Query; no background work.

- **API 5xx / network** on the list → danger `InlineAlert` (`live`) with a described error
  (`ClientsScreen.tsx:322-325`) (HT-3 correct).
- **Resend invitation fails** → inline alert (`:316-319`); the button is disabled while pending (`:443`).
- **Session read unknown** → handled by `web-shared/session` (SE-2); this area renders nothing of
  its own.
- **Client principal opens `/clients`** → staff shell mounts, staff queries fire and are refused
  (403), then `router.replace('/<org>/portal')` (`ClientPortalGate.tsx:37-42`): a visible flash of
  staff chrome and possibly a "load failed" alert (DC-6 residual).

## UX rules for its screens

**Screens and Figma nodes.** Clients EN `370:3711`, AR `370:4032`; invitations tab re-sent
`446:37206`; company detail `446:37327` (`ClientsScreen.tsx:104-116`). Client company page
`740:40765`, AR `740:41300`, phone `740:41828` and `740:42254` (`ClientCompanyScreen.tsx:65-66`).
Import contacts EN `587:33749`, AR `587:33830` (`ContactsImportScreen.tsx:53`).

**States (UX-23).**

| Screen               | Loading                                          | Empty                                            | Error                          |
| -------------------- | ------------------------------------------------ | ------------------------------------------------ | ------------------------------ |
| ClientsScreen        | 3 × `Skeleton` in `LoadingRegion` (`:351-358`)   | `TeachingEmptyState` + help `invite-a-client`    | danger alert (`:322`)          |
| ClientCompanyScreen  | skeletons (`:232-235`); summary pending (`:238`) | projects panel `hasProjects` (`:259`)           | alerts (`:228`, `:240`)        |
| ContactsImportScreen | skeleton rows (`:183-186`)                       | nothing importable disables commit (`:308`)      | preview/commit alerts (`:190`, `:281`) |

**Copy and Arabic (UX-15, UX-24).** Every `t()`/`tOr()` key used by the three screens exists
in `lib/i18n/messages/en.json` and `ar.json` (36 + 10 + 37 keys, checked by script at
`3b7e4fa7`). `tOr` carries an English fallback, which would hide a missing key in other locales.
Dates use `Intl.DateTimeFormat(locale, …)` (`ClientsScreen.tsx:240-243`). One literal symbol in
copy ("Sent ✓", comment `:115`) is not verified as catalogued.

**RTL (UX-14).** `styles/screens/clients.css` has no physical `left/right/margin-left/…`
properties (grep: 0). Arabic artboards exist for all three screens.

**Accessibility (UX-4…UX-9).** `/[orgSlug]/clients` is in the axe audit as owner
(`e2e/tests/a11y-audit.spec.ts:379`, tags WCAG 2.2 A/AA `:50`). **Not audited:** the company page
and `/clients/import`. Search uses `<form role="search">` (`ClientsScreen.tsx:255`); controls come
from `@tmanage/ui` (`Button size="accessible"`). Target size, focus and contrast: not verified
beyond the audit.

**Perceived performance (UX-17).** Pending buttons show `busy`/`loading` (`:457`,
`ContactsImportScreen.tsx:306`). **VR (UX-18):** a story exists for the company page only
(`apps/web/stories/ClientCompany.stories.tsx`). **Persona evaluation (UX-19):** not found for this area.

## Standards that apply

- **AR-3** the area reaches the API only through `lib/api/*`. Keep.
- **AR-8** capability interpretation once via `@tmanage/domain` (I-2). Keep.
- **AR-9** two decision defaults (`?? false`, fail-closed hook). Render pending/unknown instead.
- **AR-10** shapes paired (§3). Keep.
- **HT-2 / HT-3** errors are classified by `useDescribeApiError` / `describePeopleError`; no
  collapse to `[]`/`null` found in these screens.
- **HT-5** query parameters carry only `view` and `health`, no personal data. Keep.
- **IP-9** every page is `'use client'` although it only reads params; the screen could stay a
  client leaf under a server page.
- **IP-10** no effects used to derive state in the pages; the redirect effect lives in the gate.
- **DC-2** no rule copied from the API found here.
- **DC-6** residual (I-1, §6).
- **QM-2** security before convenience: a client is redirected even at the cost of a flash.
- **UX-2 / UX-19** design review and persona report: not found for this area.

## How to change this part

- **New sub-route** (e.g. `/clients/[id]/billing`): a thin `page.tsx` that parses params and
  renders a screen from `components/screens/`; no data fetching or logic in the route file.
- **New action:** gate the button with `useShellCapability(...)` for the capability the API
  checks; show the server's refusal if it still refuses (the API decides).
- **New data:** add the call to `lib/api/clients.ts` (or a new `lib/api/*` file), the pair to
  `e2e/contracts/api-web-shapes.ts`, and loading / empty / error states (UX-23).
- **Copy:** add keys to every catalog in `lib/i18n/messages/*.json` (UX-15); Arabic artboard in
  Figma first (Figma is the design).
- Checks: `pnpm --filter @tmanage/web typecheck`, `apps/web/tests/clients-screen.test.tsx`,
  `client-company-screen.test.tsx`, `r46-contacts-import.test.tsx`, the a11y audit.

## Tests and fitness checks

- Unit/component: `apps/web/tests/clients-screen.test.tsx`, `client-company-screen.test.tsx`,
  `r46-contacts-import.test.tsx`, `activity-feed.test.tsx`, `teaching-empty-states.test.tsx`.
- E2E: `e2e/tests/business-view-journeys.spec.ts:258` (company page), `ux1-share-with-client.spec.ts`,
  `client-approval-journeys.spec.ts`.
- Accessibility: `e2e/tests/a11y-audit.spec.ts:379` (list only).
- Contract: `e2e/contracts/api-web-shapes.ts:1293-1297`.
- **Missing:** an e2e "client member opens `/clients` → lands on `/portal` with no staff chrome"
  (DC-6); axe on the company page and import; VR for the list and import.

## Open defects, decisions and risks

| Id    | Class        | Finding (verified at 3b7e4fa7)                                                                         | Pri | Exit                                                   |
| ----- | ------------ | ------------------------------------------------------------------------------------------------------ | --- | ------------------------------------------------------ |
| WCL-1 | DC-6         | Gates render the staff screen while audience/membership is unknown (`ClientPortalGate.tsx:31-33`, `MembershipGoneGate.tsx:53`) | P1  | render nothing (or a neutral loader) until audience is known; e2e |
| WCL-2 | AR-9         | `mayViewFinance … ?? false` (`ClientCompanyScreen.tsx:123`); fail-closed capability hook hides actions on read failure | P2  | tri-state: pending / allowed / refused                 |
| WCL-3 | UX-4         | axe audit covers only `/clients`                                                                       | P2  | add company page and import                            |
| WCL-4 | IP-9         | route files are client components; fixture org name prop on every page                                 | P2  | server page + client screen; drop the fixture prop     |
| WCL-5 | UX-18/UX-19  | no VR for list/import; no persona report                                                               | P2  | stories + baselines; persona evaluation                |

## Glossary

| Term           | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| Client company | a customer organization of the workspace (AR `RouteTitle.clientCompany`: شركة العميل) |
| Invitation     | a pending invite of a client person; can be re-sent                     |
| ONEPAGE        | the client company page built from one summary read                     |
| Audience       | `staff` or `client` side of the organization for the signed-in person   |
