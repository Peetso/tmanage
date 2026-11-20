---
part: web/org/files
kind: web-area
context: files-and-storage
owner: implementation-lead
lifecycle: production
depends_on:
  [
    web-shared/screens,
    web-shared/viewer,
    web-shared/shell,
    web-shared/session,
    web-shared/api-client,
    web-shared/help,
    package/ui,
  ]
provides_api: []
consumes_api:
  [
    '/v1/organizations/:orgSlug/projects',
    '/v1/organizations/:orgSlug/projects/:projectId/files',
    '/v1/organizations/:orgSlug/upload-sessions/*',
    '/v1/uploads/:providerUploadId/parts/:n',
    '/v1/organizations/:orgSlug/files/*',
    '/v1/organizations/:orgSlug/review/*',
    '/v1/organizations/:orgSlug/client-organizations/:id',
    '/v1/organizations/:orgSlug/client-organizations/:id/projects',
  ]
tables_owned: []
rules: [AR-3, AR-8, AR-9, AR-10, HT-2, HT-3, HT-4, HT-5, IP-9, DC-1, DC-6, QM-2]
ux_rules: [UX-2, UX-4, UX-5, UX-6, UX-9, UX-14, UX-15, UX-16, UX-17, UX-18, UX-19, UX-23, UX-24]
last_verified_commit: 3b7e4fa70eb6facff3f1dccc65c0867f0707a0a6
last_verified_date: 2026-11-20
last_verified_by: Claude Opus 5.5 (lane H)
---

# web/org/files

Read this before changing any file under `apps/web/src/app/[orgSlug]/files/**` or the screens it
renders. Rule IDs refer to `docs/architecture/ENGINEERING-STANDARD.md`,
`IMPLEMENTATION-PATTERNS.md` (IP) and `UI-UX-DESIGN-STANDARD.md` (UX). Every `file:line` was
checked at `3b7e4fa7`. Paths under `apps/web/src/` are written from `src/`.

## Purpose and bounded context

**What it is for.** The staff face of the **Files & Storage** context (VIEWS §4): the rail's
"Files" hub (every ready file of the projects the person can read, newest first, with upload by
button or drop) and the full-page file viewer (proofing: zoom, pins, threads, versions,
decisions). It renders `api/files`; the viewer itself is the shared part `web-shared/viewer`.

**Who uses it.** Internal members. Clients have their own doors (`/[orgSlug]/portal/files`,
portal viewer) and must not land here (DC-6).

**Route files (thin, all `'use client'`):**

- `/[orgSlug]/files?project=<id>&client=<id>` → `FilesHubScreen`
  (`app/[orgSlug]/files/page.tsx:8-27`); `project` preselects a project, `client` narrows to the
  projects shared with one client company (used by the client page's Files tab).
- `/[orgSlug]/files/[fileId]?deliverableVersionId=&thread=` → `FileViewer`
  (`[fileId]/page.tsx:8-36`); opening another file uses `router.push`.

Both pass `FIXTURE_ORGANIZATION_NAME` (`lib/fixtures.ts:31`) as the name; the shell shows the
real one and never the fixture (`lib/use-organization-names.ts:52-67`).

**Context relations.** Hub reads projects (`lib/api/projects.ts`) and, with `?client=`, the client
company and its shared projects (`lib/api/clients.ts`) — Work Management and Client Portal are
upstream of this screen as well as Files.

## Domain model and invariants

No domain model of its own. Invariants the area keeps:

- **I-1** A file's safety label comes from the API's state (`virus_scanned` / `checked`), the
  same label in list and viewer (`components/viewer/FileViewer.tsx:295-298`); the web never
  re-derives it from a scan verdict (AR-8, AR-9).
- **I-2** Uploads use the one upload path with an `Idempotency-Key` per file; a retry after a
  busy host reuses the key (`lib/api/uploads.ts:11,237,612-614`) (HT-4).
- **I-3** A file uploaded from the hub goes to the chosen project, or the only one; with several
  projects and none chosen, the person is asked (`FilesHubScreen.tsx:124-142`). It stays internal
  until shared.
- **I-4** In the viewer, 404 renders a neutral "unavailable" notice, any other failure a danger
  alert with the described error (`FileViewer.tsx:677-688`) — no collapse to "missing".
- **I-5** A failed per-project file list must not read as "no files" — **violated today** (§11 WFL-1).

## Public API and contracts

n/a — a web area exposes no API. Calls, through `lib/api/*` (AR-3):

- Hub: `listProjects` (`lib/api/projects.ts`), `listProjectFiles` (`lib/api/file-folders.ts`,
  `GET …/projects/:id/files`), `uploadProjectFile` + `formatBytes` (`lib/api/uploads.ts:468`),
  `getClientOrganization`, `listClientProjects` (`lib/api/clients.ts`).
- Viewer: `lib/api/file-preview.ts` (staff or portal door, `…${portal}/files/:id/preview`),
  `lib/api/review.ts`, `lib/api/file-review-decisions.ts`, `lib/api/attachment-versions.ts`
  (`…/files/:id/versions`), `lib/api/uploads.ts` (delete, new version), downloads via
  `apiBaseUrl()` (`FileViewer.tsx:9,341`).

Contracts: `_projectFile` (`e2e/contracts/api-web-shapes.ts:2263`) for the hub row; preview
manifest, review threads, decisions and folders imported at `:392-431`.

## Data: tables and migrations

n/a — web area; no tables. Query keys: `['projects', orgSlug]`, `['project-files', orgSlug, ids]`
(`FilesHubScreen.tsx:84-86,111-121`), client company keys shared with the client page
(`clientCompanyKey`, `:88-98`). Viewer polling: threads every 10 s, pending files every 5 s
(`FileViewer.tsx:129-132`).

## Permissions and tenant rules

- The API decides every read: the hub lists a project only if `file.download` passes there
  (`FilesHubScreen.tsx:44-48` comment); uploads need `file.upload` server-side.
- No capability or role literal in the hub or viewer (grep for role names: none).
- **Trust zone:** staff. A client principal reaching `/files` or `/files/:id` is redirected by
  `ClientPortalGate` to the portal **home**, not to the same file's portal view
  (`components/shell/ClientPortalGate.tsx:8-10,32`), and only after the audience has loaded (DC-6).
- No token or personal data in the URL: only ids and `thread` (HT-5). The part-sink upload URL
  with `?t=` is produced by the API (see `api/files` FIL-6).

## Runtime, background work and failure modes

Client components with TanStack Query. The viewer polls (no realtime topic yet).

- **One project's file list fails** (403, 5xx, network) → `.catch(() => [])`
  (`FilesHubScreen.tsx:116`): the files of that project silently vanish and, if it was the only
  one, the **empty state** shows — DC-1 / HT-3. Intended only for "refused" projects (comment
  `:47-48`).
- **Shared-projects read fails with `?client=`** → `shared.data ?? []` (`:99-103`) leaves no
  projects; the error branch checks only `projects.isError || files.isError` (`:290`) → empty
  state instead of an error. HT-3.
- **Projects list fails** → danger alert (`:290-297`). Correct.
- **Upload error** → the queue shows `error.message` for API and non-network errors
  (`:134-138`); that text is the server's, not a catalogued message (UX-15 risk).
- **Viewer manifest fails** → I-4. **File still being checked** → state card and 5 s poll.
- **Client principal** → staff shell mounts first, then redirect (DC-6 residual).

## UX rules for its screens

**Screens.** Files hub: Figma "TManage Screens — Files and Approvals", FIL-01
(`FilesHubScreen.tsx:44`). Viewer: Figma batch A V-01…V-06 and batch B V-10…V-15
(`FileViewer.tsx:307-308`). Node ids are not written in the code for these screens.

**States (UX-23).**

| Screen     | Loading                                    | Empty                                                    | Error / unknown                         |
| ---------- | ------------------------------------------ | -------------------------------------------------------- | --------------------------------------- |
| Files hub  | 3 × `Skeleton` (`:300-304`)                | `TeachingEmptyState` + help (`:314-325`)                 | alert (`:290`); **collapses** (§6)      |
| Viewer     | `Skeleton 480px` in `LoadingRegion` (`:671-676`) | "no preview" card for unknown formats                | neutral 404 / danger other (`:677-688`) |

**Copy and Arabic (UX-15, UX-24).** All 26 hub keys and 27 viewer keys used via `t()`/`tOr()`
exist in `lib/i18n/messages/en.json` and `ar.json` (checked by script at `3b7e4fa7`). Server
error text in the upload queue is the exception (§6).

**RTL (UX-14).** The viewer takes its direction from the locale (`localeDirection(locale)`,
`FileViewer.tsx:339`). `components/viewer/viewer.css` has three physical properties: `right` on
the stage chip (`:233`, a UX-14 breach) and `left`/`right` on pin popovers keyed to
`data-side` (`:371,375`, geometric, acceptable with a note).

**Accessibility (UX-4…UX-9).** **Not audited:** neither `/files` nor `/files/:id` is in
`e2e/tests/a11y-audit.spec.ts` (only `portal files` as client, `:398`). The hub's drop zone has a
hidden file input (`aria-hidden`, `tabIndex={-1}`, `FilesHubScreen.tsx:208-214`) driven by a
visible button; the upload list, project filter and table carry `aria-label`s (`:246,264,347`).
Keyboard reachability of pins/drawing tools: not verified here.

**Perceived performance (UX-17).** Skeletons, busy buttons on pending mutations. The hub makes
one request per project in scope (`:113-118`) — N requests on "All projects".
**Motion (UX-16):** not reviewed. **VR (UX-18):** `apps/web/stories/FileViewer.stories.tsx`
exists; no story for the hub. **Persona evaluation (UX-19):** not found.

## Standards that apply

- **AR-3** only `lib/api/*`. Keep.
- **AR-8 / AR-9** safety label and servability are the API's decisions (I-1). Keep.
- **AR-10** hub row paired (`_projectFile`). Keep.
- **HT-2** errors are described through `useDescribeApiError`; viewer distinguishes 404.
- **HT-3 / DC-1** two collapses in the hub (§6). Fix: keep refusals (403/404) out, surface the rest.
- **HT-4** idempotent uploads (I-2). Keep.
- **HT-5** no secrets in this area's URLs. Keep.
- **IP-9** route files are client components that only read params. Server page + client leaf.
- **DC-6** residual through the shell gates (see `web/org/clients` WCL-1).
- **QM-2** a file not yet scanned is labelled, never shown as safe. Keep.
- **UX-2 / UX-19** design review and persona report for the hub: not found.

## How to change this part

- **New hub filter or column:** in `FilesHubScreen`; data from `lib/api/file-folders.ts`; add the
  field to the API view and the contract pair first (AR-10).
- **New viewer stage or format:** in `components/viewer/` (part `web-shared/viewer`, read its
  PART.md); the API decides whether a preview exists (`file-preview.ts` manifest).
- **New query parameter:** parse it in the route file, pass it as a prop; ids only (HT-5).
- **Error handling:** never `.catch(() => [])` a list; classify (refused → skip, otherwise
  error state), UX-23.
- **Copy:** every catalog in `lib/i18n/messages/*.json`; map server errors to catalogued messages.
- Checks: `pnpm --filter @tmanage/web typecheck`; tests in §10; add the routes to the axe audit.

## Tests and fitness checks

- Component: `apps/web/tests/fix3-files-hub.test.tsx`, `fix5-file-delete.test.tsx`,
  `r4-file-viewer.test.tsx`, `r4-draw-tools.test.tsx`, `r4-versions-decisions.test.tsx`,
  `viewer-agency-formats.test.tsx`, `fig-file-stage.test.tsx`, `proofing-off-viewer.test.tsx`,
  `teaching-empty-states.test.tsx`.
- E2E: `e2e/tests/upload-journeys.spec.ts` drives uploads through the API (`:206,233,323`); **no
  e2e opens `/files` or `/files/:id`** (grep).
- Story: `apps/web/stories/FileViewer.stories.tsx`.
- **Missing:** axe on both routes; e2e "one project's list fails → error, not empty"; client
  principal on `/files/:id` journey; hub VR baseline.

## Open defects, decisions and risks

| Id    | Class       | Finding (verified at 3b7e4fa7)                                                                  | Pri | Exit                                         |
| ----- | ----------- | ----------------------------------------------------------------------------------------------- | --- | -------------------------------------------- |
| WFL-1 | DC-1 / HT-3 | `listProjectFiles(...).catch(() => [])` hides 5xx/network as "no files" (`FilesHubScreen.tsx:116`) | P1  | skip only 403/404; otherwise error state     |
| WFL-2 | HT-3        | `?client=` shared-projects failure renders the empty state (`:99-103,290`)                      | P2  | include `shared.isError` / `company.isError` |
| WFL-3 | UX-4        | `/files` and `/files/:id` not in the axe audit                                                  | P1  | add both (owner)                             |
| WFL-4 | DC-6        | client redirected to portal home after the staff shell mounted                                   | P2  | gate waits for audience; deep-link to portal file |
| WFL-5 | UX-14       | `right:` on `.tm-viewer-stage__chip` (`components/viewer/viewer.css:233`)                       | P2  | `inset-inline-end`                           |
| WFL-6 | UX-15       | upload queue shows raw server `error.message` (`FilesHubScreen.tsx:134-138`)                    | P2  | catalogued message per error code            |
| WFL-7 | perf        | N file-list requests for "All projects" (`:113-118`)                                            | P2  | one org-wide files endpoint                  |

## Glossary

| Term     | Meaning                                                                            |
| -------- | ---------------------------------------------------------------------------------- |
| Files hub| the rail's "Files" page: all ready files of the readable projects                 |
| Viewer   | the proofing viewer for one file (pins, threads, versions, decisions)             |
| Checked  | label for a file that passed TManage's checks but no virus scanner (AR catalog `DownloadScan.notScanned`: عدّى المراجعة) |
| Door     | staff (`/files`) or client (`/portal/files`) entry to the same file               |
