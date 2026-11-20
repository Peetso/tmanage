---
part: api/files
kind: api-module
context: files-and-storage
owner: implementation-lead
lifecycle: production
depends_on:
  [
    api-common/database,
    api-common/http,
    api/audit,
    api/platform,
    api/tenancy,
    api/billing,
    api/projects,
    api/work,
    api/approvals,
    api/requests,
    api/google-drive,
    api/onedrive,
    api/cloud-folders,
    api/figma,
    api/public-forms,
    package/domain,
    package/storage,
    package/config,
  ]
provides_api:
  [
    '/v1/organizations/:orgSlug/upload-sessions/*',
    '/v1/organizations/:orgSlug/portal/upload-sessions/*',
    '/v1/uploads/:providerUploadId/parts/:n',
    '/v1/public/forms/:slug/uploads/*',
    '/v1/organizations/:orgSlug/files/*',
    '/v1/organizations/:orgSlug/portal/files/*',
    '/v1/organizations/:orgSlug/portal/projects/:projectId/files',
    '/v1/organizations/:orgSlug/projects/:projectId/folders/*',
    '/v1/organizations/:orgSlug/projects/:projectId/files',
    '/v1/organizations/:orgSlug/file-tags',
    '/v1/organizations/:orgSlug/review/*',
    '/v1/organizations/:orgSlug/portal/review/*',
    '/v1/organizations/:orgSlug/admin/file-safety/blocked/*',
    '/v1/organizations/:orgSlug/usage',
    '/v1/organizations/:orgSlug/work-items/:workItemId/{drive,onedrive}-files',
    '/v1/organizations/:orgSlug/deliverables/:deliverableId/{drive,onedrive}-files',
  ]
consumes_api: []
tables_owned:
  [
    file_assets,
    file_versions,
    upload_sessions,
    usage_counters,
    usage_ledger_entries,
    file_folders,
    file_tags,
    file_comments,
    file_previews,
    review_threads,
    review_comments,
    file_review_decisions,
    attachment_versions,
  ]
rules:
  [
    SE-1,
    SE-6,
    AR-5,
    AR-6,
    AR-7,
    AR-8,
    AR-10,
    HT-1,
    HT-3,
    HT-4,
    HT-5,
    DA-1,
    DA-10,
    DA-11,
    DA-12,
    AS-1,
    AS-4,
    AS-6,
    ST-1,
    ST-6,
    RT-2,
    RT-3,
    QM-2,
    IP-3,
    IP-6,
    IP-17,
  ]
ux_rules: []
last_verified_commit: a7169b1c2cba173146f8bd89c4cfade7483d4231
last_verified_date: 2026-11-20
last_verified_by: Claude Opus 5.5 (lane I, SCANNER-TLS rows)
---

# api/files

Read this before changing any file under `apps/api/src/modules/files/**`. Rule IDs refer to
`docs/architecture/ENGINEERING-STANDARD.md`, `IMPLEMENTATION-PATTERNS.md` (IP) and
`UI-UX-DESIGN-STANDARD.md` (UX). Every `file:line` was checked at `3b7e4fa7`. Paths are relative
to this folder unless they start with `apps/`, `e2e/`, `packages/` or `docs/`.

## Purpose and bounded context

**What it is for.** The core of the **Files & Storage** context (VIEWS §4): every byte a person,
a client, a public form or a cloud import puts into TManage passes here. It owns:

1. **Upload** — reserve quota, accept parts, complete, verify the content signature and archive
   structure, scan for malware, then `ready` or `rejected` (upload state machine).
2. **Serve** — downloads and previews (staff and portal doors), with the one sharing rule for
   clients.
3. **Organise and review** — folders, tags, comments, review threads/pins, review decisions,
   attachment versions.
4. **Account** — storage counters, ledger, thresholds, reconciliation, purge of blocked and
   expired objects.

**Who uses it.** Staff web (`web/org/files`, the viewer `web-shared/viewer`, work items,
deliverables), the portal (`…/portal/files`, `…/portal/upload-sessions`), public forms
(`/v1/public/forms/:slug/uploads`), `api/clients` (deliverable files via `ClientFileSharing`,
`apps/api/src/modules/clients/clients.module.ts:194-195`), inbound e-mail attachments
(`apps/api/src/modules/inbound-email/inbound-attachment-scan.ts`), and the in-app scheduler
(`apps/server/scheduled-sweeps.mjs:167-215`).

**Context map.** Files is **upstream** of Work, Portal and Billing (VIEWS §4). It is also a
heavy **downstream** consumer: `files.module.ts` imports projects, requests, approvals, work,
billing, Google Drive, OneDrive, cloud-folders, tenancy, Figma, admin and public-forms code
(`files.module.ts:29-141`), including **functions exported from other modules' controller files**
(`googleDriveServiceFor` from `google-drive.controller.js`, `oneDriveServiceFor` from
`onedrive.controller.js`, `:52,55`; `PUBLIC_FORM_ATTACHMENT_GATE` from `public-forms.controller.js`, `:140`).

## Domain model and invariants

**Upload state machine** (`packages/domain/src/state-machines/upload.ts:4-55`): `created →
uploading → uploaded → verifying → scanning → ready`; `rejected` from `verifying`/`scanning`
(requires `rejectionCode`); `expired` and `cancelled` from the early states. Terminal: `ready`,
`rejected`, `expired`, `cancelled`.

**Servable** (one rule, AR-8): a version is servable iff its state is servable, its
`scanVerdict === 'clean'` and its `trustZone === 'private'` (`isServableVersion`,
`upload.ts:80-90`).

**Client file state** (`client-file-sharing.ts:46-64`): `virus_scanned` when servable; otherwise
`checked` only if the org's client-files policy is `checked`, team downloads are
`allow_labeled`, the version is still awaiting a scan and passed the current signature/archive
checks (`ARCHIVE_CHECKS_LIVE_SINCE`, `:70`); else not shareable (`null`).

**Upload channels and limits** (`file-safety.ts:67-73`): `member | client | public_form |
inbound_mail`; a client file is at most 100 MiB and a client may start 20 uploads a day
(`CLIENT_MAX_FILE_BYTES`, `CLIENT_DAILY_UPLOAD_LIMIT`, enforced `file-safety.ts:440`,
`files.service.ts:2091`). Who may upload/download for which purpose: `purpose-policy.ts:44,89`.

**Invariants (checkable)** — statement · where · proof:

- **I-1** A quota reservation succeeds only if `used + reserved + bytes <= limit`, in one
  conditional statement (no lost update) · `usage-counters.repository.ts:114-138` ·
  `apps/api/test/file-001-quota.db.test.ts`.
- **I-2** Creating an upload session requires an `Idempotency-Key`; a repeat returns the same
  session · `upload-sessions.controller.ts:53-58`, `files.service.ts:675,811` ·
  `apps/api/test/file-001-upload-sessions.db.test.ts`.
- **I-3** Only a `ready`, clean, private version is served to staff; a client gets a file only
  through `clientFileState` · `upload.ts:80-90`, `client-file-sharing.ts:46-64` ·
  `client-file-sharing.test.ts`, `apps/api/test/file-004-download-scan-policy.db.test.ts`.
- **I-4** A declared type must match the content signature, else `rejected` with
  `hash_mismatch | type_not_allowed | type_mismatch` · `content-signature.ts:75-78` ·
  `content-signature.test.ts`, `apps/api/test/file-002-verification.db.test.ts`.
- **I-5** A scan claim is a column taken conditionally on the row's `version`; a claim older
  than 15 min is retaken; a failed scan leaves the claim standing · `file-scanner.ts:38-46,104-110` ·
  `file-scanner.test.ts`, `apps/api/test/file-002-scanning.db.test.ts`.
- **I-6** An unreachable scanner is probed **before** any row is claimed · `file-scanner.ts:77,180` ·
  `file-scanner.test.ts`.
- **I-7** Expired upload reservations are released by the sweeper (grace 60 s) ·
  `upload-session-sweeper.ts:94-97` · `apps/api/test/usage-001-expiry-sweeper.db.test.ts`.
- **I-8** Counters equal the ledger after reconciliation · `usage-reconciler.ts:91` ·
  `apps/api/test/usage-001-reconcile.db.test.ts`.
- **I-9** Rejected/quarantined objects are purged after `FILE_RETENTION_REJECTED_DAYS` (default 30)
  · `quarantine-cleanup.ts:85-86`, `files.module.ts:302`, `packages/config/src/env.ts:337` ·
  `quarantine-cleanup.test.ts`, `apps/api/test/file-003-lifecycle.db.test.ts`.
- **I-11** (SCANNER-TLS) The clamd driver speaks TLS 1.3 when `CLAMAV_TLS=1` and trusts the server
  only by a SHA-256 pin or a CA; a pin mismatch or a failed handshake is `ScannerUnavailableError`
  (nothing claimed, file stays `scanning`); production refuses clear text to a host that is not
  loopback/private · `apps/api/src/common/scan/clamav-scanner.ts` (`dialTls`, `pinMatches`),
  `packages/config/src/env.ts` (`isLoopbackOrPrivateHost`) · `malware-scanner.test.ts`, `env.test.ts`.
- **I-10** Production refuses the `stub` scanner (but accepts `none`) ·
  `packages/config/src/env.ts:720,899-909`.

## Public API and contracts

All routes carry `@RequireCapability` under the global chain except the two `@Public` doors.
Paths under `/v1/organizations/:orgSlug` unless absolute.

- **Upload (staff)** `file.upload`: POST 201 (Idempotency-Key) · GET `upload-sessions`, GET
  `:id`, POST `:id/complete`, POST `:id/cancel` (`upload-sessions.controller.ts:43-112`).
- **Upload (client)** `file.upload`: same set under `portal/upload-sessions`
  (`portal-upload-sessions.controller.ts:41-89`), channel `client`.
- **Upload (public form)** `@Public`: POST, `:id/complete`, `:id/cancel` under
  `/v1/public/forms/:slug/uploads` (`public-form-uploads.controller.ts:35-110`).
- **Parts** `@Public @NoTenant` PUT `/v1/uploads/:providerUploadId/parts/:n?t=<token>` — the
  local part sink; the token is in the **query string** (`upload-parts.controller.ts:71-95`).
- **Read/serve (staff)** `file.download`: GET `files/:id/content` (`file-downloads.controller.ts:25-26`),
  GET `files/:id/preview` · `:previewId/content`, POST `retry` (`file.upload`)
  (`file-previews.controller.ts:28-65`), GET `projects/:id/files` · `folders` · `folders/:fid/files`
  (`folders.controller.ts:37-59`).
- **Read/serve (client)** GET `portal/files/:id/content`, `…/preview[/:previewId/content]`
  (`file.download`), GET `portal/projects/:id/files` (`client_projection.read`)
  (`portal-file-downloads.controller.ts:23-24`, `portal-file-previews.controller.ts:25-42`,
  `portal-file-list.controller.ts:25-26`).
- **Organise** folders POST (`file.upload`) / DELETE (`file.delete`), PUT `files/:id/folder`
  (`folders.controller.ts:71-96`); tags (`file-tags.controller.ts:27-62`); comments
  (`comments.controller.ts:31-58`); DELETE `files/:id` + POST `:id/restore`
  (`file-delete.controller.ts:30-42`); versions GET/POST (`attachment-versions.controller.ts:32-44`).
- **Review** threads/comments/resolve under `files/:id/review` and `review/threads/*`
  (`review.controller.ts:53-173`), portal twins (`portal-review.controller.ts:61-180`); decisions
  GET (`file.download`) / POST (`approval.decide`), staff and portal (`file-review-decisions.controller.ts:24-74`).
- **Cloud import** POST `work-items/:id/{drive,onedrive}-files` (`work.update`),
  `deliverables/:id/{drive,onedrive}-files` (`deliverable.create`) (`cloud-import.controller.ts:52-95`).
- **Admin** GET + POST `:fileId/delete` `admin/file-safety/blocked` (`org.security.manage`,
  `blocked-files.controller.ts:99-107`); GET `usage` (`org.manage`, `usage.controller.ts:30-31`).

**Contracts (AR-10).** Pairs in `e2e/contracts/api-web-shapes.ts`: `_projectFile` (`:2263`),
`_portalFile` (`:1281`), `_portalDeliverableFile` (`:1287`), `_fileTag` (`:2177`), review threads,
preview manifest, folders and decisions (imports `:392-431`). **No pair for `UploadSessionView`** (grep).

**Events (outbox, AS-1).** `upload.completed.v1` (`files.service.ts:1399`), `file.ready.v1`
(`file-scanner.ts:467`), `file.rejected.v1` (`file-scanner.ts:527`, `file-verifier.ts:462`),
`file.purged.v1` (`files.service.ts:1624`), `usage.storage_{reserved,committed,released}.v1`
(`files.service.ts:954`), `usage.threshold_reached.v1` (`usage-thresholds.ts:172`),
`file.preview_{ready,removed}.v1`, `review.{thread_created,comment_added,thread_resolved,decision_recorded}.v1`.
Audit: `file_asset.{uploaded,verified,scanned,scan_failed,scan_disputed,rejected,deleted,restored,purged,version_added}`,
`upload_session.{expired,refused,abort_failed}`.

**Exported providers** (`files.module.ts:760`): service, tags, folders, comments, usage, sweeper,
reconciler, cleanup, verifier, scanner, preview job, preview orphan sweeper, scan job, downloads,
previews.

## Data: tables and migrations

| Table                                          | Created                                       | Notes                                          |
| ---------------------------------------------- | --------------------------------------------- | ---------------------------------------------- |
| `file_assets`, `file_versions`                 | `0015_file_uploads.sql`                       | state, `scan_verdict`, `trust_zone`, claim col |
| `upload_sessions`, `usage_counters`            | `0015_file_uploads.sql`                       | idempotency key; conditional reserve           |
| `usage_ledger_entries`                         | `0021_usage_ledger_entries.sql`               | idempotency key per entry                      |
| `file_tags`                                    | `0140_file_tags.sql`                          | —                                              |
| `file_folders`, `file_comments`                | `0198_file_folders.sql`, `0199_file_comments.sql` | page cap `MAX_FILE_FOLDERS_PAGE`           |
| `attachment_versions`                          | `0228_attachment_versions.sql`                | —                                              |
| `file_previews`                                | `0267_file_previews.sql`                      | orphan sweep                                   |
| `review_threads`, `review_comments`            | `0268_review_threads.sql`                     | —                                              |
| `file_review_decisions`                        | `0269_file_review_decisions.sql`              | —                                              |

**Read but not owned:** `deliverable_versions` (approvals, `0027`), `memberships`,
`project_memberships`, `client_memberships`, `project_clients` (tenancy / clients —
`review-mention-candidates.repository.ts:6-8,88-98`), `client_projections` (approvals —
`client-file-reach.repository.ts`, which also imports `deliverableIsLive` from
`../approvals/client-projections.repository.js`), org settings (tenancy, via `ClientFileSharing`).

**Objects.** Bytes live in the object store (`packages/storage`), or in Google Drive / OneDrive
for provider-backed files (`provider-objects.ts:26-28`, backends `local | google_drive | onedrive`).

**Time.** 36 `current_timestamp(3)` writes across the module (e.g. 11 in
`usage-counters.repository.ts`, 8 in `file-assets.repository.ts`) — DA-10.

## Permissions and tenant rules

Capabilities: `file.upload`, `file.download`, `file.delete`, `approval.decide`, `work.update`,
`work.read`, `deliverable.create`, `client_projection.read`, `org.manage`, `org.security.manage`.

| Decision                                 | Single owner                                         |
| ---------------------------------------- | ---------------------------------------------------- |
| Is a version servable?                   | `isServableVersion` (`upload.ts:80`)                 |
| May a client get this file?              | `ClientFileSharing` / `clientFileState`              |
| May this principal kind use this purpose | `mayUploadFor` / `mayDownloadFor` (`purpose-policy.ts:44,89`) |
| Is the content what it claims?           | `content-signature.ts`, `archive-inspection.ts`      |
| Quota                                    | `usage-counters.repository.ts:114-138` + billing allowance |

**Trust zones.** Staff doors (`files/*`), client doors (`portal/files/*`, `portal/upload-sessions`,
`portal/review/*`), and two anonymous doors: public-form uploads (`@Public`, gated by
`PublicFormAttachmentGate`) and the part sink (`@Public @NoTenant`, bearer token in the URL).
Every tenant read goes through `tenantDrizzle` (DA-12); job passes build a service context per
organization (`scannerContextFor`, `file-scanner.ts:116`).

## Runtime, background work and failure modes

**Jobs owned** (IP-17): verifier (`file-verifier.ts`), scanner (`file-scanner.ts`), preview job
(`preview-job.ts`), preview orphan sweeper, upload-session sweeper, usage reconciler, quarantine
cleanup, usage thresholds.

**Where they run.** In the single Hostinger app: the scan job (verify + scan) and the preview job
run in-process only when `WORKER_INPROCESS=1` or `FILE_SCAN_INPROCESS=1` / `FILE_PREVIEW_INPROCESS=1`
(`file-scan-job.ts:41-43`, `preview-job.ts:110-112`), on a `setInterval` (`file-scan-job.ts:66-69`)
with no lease — two instances both run, and the row claim (I-5) prevents double judgement.
Upload sweep (minute), reconcile (hourly) and preview orphan sweep run from
`apps/server/scheduled-sweeps.mjs:167-215` under a named lock per sweep (`:30-32`).
**Quarantine cleanup has no in-app twin:** `cleanup:once` (`apps/api/package.json:22`,
`apps/api/src/cleanup.ts`) expects an external tick, and no `apps/server/*.mjs` file mentions it.

- **Scanner unreachable** → probed first, nothing claimed, one line (I-6). Correct.
- **Scan of one object times out** → `ScanError('timeout')` after `MALWARE_SCAN_TIMEOUT_MS`
  (default 30 s, `packages/config/src/env.ts:722`; `apps/api/src/common/scan/clamav-scanner.ts:101-124`);
  the claim stands and the row is retried after 15 min. Correct (ST-1).
- **Cloud import hangs** → Drive/OneDrive transports call `fetchImpl` with **no timeout**
  (`apps/api/src/modules/google-drive/google-drive.google.ts:372,412,541`); a hung Google call holds
  the request. Gap (ST-1, owned by google-drive/onedrive, felt here).
- **No scanner in production** → `MALWARE_SCAN_DRIVER=none` is accepted (only `stub` is refused,
  `env.ts:903`); then no version is ever `virus_scanned` and clients receive only `checked` files
  when the org allows it. Product decision, needs an ADR (QM-2).
- **Two instances** → counters are conditional SQL (I-1); sweeps take named locks; scan job
  relies on row claims (RT-2, RT-3).
- **Quarantine cleanup never runs on live** → objects past retention stay (ST-6). Suspected DC-7.

## UX rules for its screens

n/a — API module. Screens belong to `web/org/files`, `web-shared/viewer` and the portal area.
The API's obligation (AR-9): return the file state (`virus_scanned`/`checked`, preview ready,
blocked reason) as decisions; screens never re-derive them from scan verdicts.

## Standards that apply

- **SE-1** every route has a capability or is deliberately `@Public`. Keep both public doors in the route census.
- **SE-6** public-form uploads and the part sink are trust boundaries; STRIDE rows not verified here.
- **AR-5 / AR-7** **breach**: `files.module.ts:29-141` builds other modules' repositories and
  imports helpers from their controller files; `review-mention-candidates.repository.ts` reads
  tenancy/clients tables directly. Target: read services.
- **AR-6** **breach**: `BlockedFilesController` injects `FILE_ASSETS_REPOSITORY` and calls
  `listBlockedFiles` itself (`blocked-files.controller.ts:11,95,102,111-113`). Move into the service.
- **AR-8** servable, client-shareable and purpose rules each live once (§5). Keep.
- **AR-10** most pairs present; add `UploadSessionView`.
- **HT-1 / HT-4** 201 on create with a required `Idempotency-Key` (I-2). Keep.
- **HT-5** the part-sink token rides in `?t=` (`upload-parts.controller.ts:82`) — the
  presigned-URL pattern; HT-5 forbids tokens in URLs, so it needs an ADR (short TTL, bound to one
  upload) or a header.
- **DA-1** quota by conditional update (I-1); scan claims by version (I-5). Keep.
- **DA-10** 36 `current_timestamp(3)` writes. Bound `Date`.
- **DA-11 / AS-1** audit + outbox rows in the same transaction as the state change. Keep.
- **AS-4 / RT-3** in-app sweeps under named locks; scan/preview jobs rely on claims only.
- **AS-6** passes are bounded (`SCAN_BATCH_SIZE = 50`, `SWEEP_BATCH_SIZE = 100`, `CLEANUP_BATCH_SIZE = 100`).
- **ST-1** scanner has deadlines; cloud transports do not.
- **ST-6** retention for rejected objects (30 days) exists but its job is not scheduled in-app.
- **QM-2** security first: unknown scan state is not servable. Keep.
- **IP-3 / IP-6** pure rules (`clientFileState`, `reconcileCounter`) with scanner/storage adapters.
- **IP-17** every job reports one line and a typed report (`ScanReport`, `SweepReport`, `CleanupReport`).

## How to change this part

- **New file route:** controller with `@RequireCapability`, logic in a service, SQL in a
  repository (AR-4, AR-6). A client door goes under `…/portal/…` and must call `ClientFileSharing`
  (never re-check `scanVerdict` by hand, AR-8).
- **New upload purpose:** add it to `UPLOAD_PURPOSES` (schema), `purpose-policy.ts`
  (`mayUploadFor`, `mayDownloadFor`, limits) and its tests; consider the client daily limit.
- **New accepted file type:** `content-signature.ts` families + `file-safety.ts` presets +
  `archive-inspection.ts` if it is a container; add fixtures to `content-signature.test.ts`.
- **New job:** a class with a typed report and batch bound (IP-17, AS-6); register it in
  `apps/server/scheduled-sweeps.mjs` **and** the worker job list, or it never runs on live (DC-7).
- **New table:** forward-only MariaDB-safe migration (DA-4, DA-5), grant in `scripts/db/users.sql`
  (DA-9), retention (ST-6).
- Checks: `pnpm --filter @tmanage/api typecheck`, the co-located tests, the file/usage db suites.

## Tests and fitness checks

- Unit (co-located, 44 files): e.g. `file-safety.test.ts`, `content-signature.test.ts`,
  `file-scanner.test.ts`, `file-scan-job.test.ts`, `file-verifier.archive.test.ts`,
  `client-file-sharing.test.ts`, `purpose-policy.test.ts`, `quarantine-cleanup.test.ts`,
  `upload-session-sweeper.test.ts`, `usage-reconciler.test.ts`, `usage-thresholds.test.ts`,
  `preview-job.test.ts`, `preview-orphan-sweeper.test.ts`, `public-form-upload.test.ts`,
  `client-upload.test.ts`, `blocked-files.test.ts`, `download-scan-policy.gate.test.ts`.
- DB (`apps/api/test`): `file-001-quota`, `file-001-upload-sessions`, `file-001b-part-transport`,
  `file-002-download`, `file-002-scanning`, `file-002-verification`, `file-003-lifecycle`,
  `file-004-download-scan-policy`, `file-005-attachment-versions`, `r4-005-review-threads`,
  `usage-001-{expiry-sweeper,ledger,reconcile,threshold}` (`*.db.test.ts`).
- E2E: `e2e/tests/upload-journeys.spec.ts`, `client-approval-journeys.spec.ts`.
- Fitness: `apps/server/scheduled-sweeps.test.mjs` (DC-7 job list) — does not cover `cleanup:once`.
- **Missing:** an AR-6 import check; a test that every `*Job`/`*Sweeper`/`*Cleanup` class has an
  in-app scheduler entry; a timeout test for cloud imports.

## Open defects, decisions and risks

| Id    | Class       | Finding (verified at 3b7e4fa7)                                                                      | Pri | Exit                                       |
| ----- | ----------- | --------------------------------------------------------------------------------------------------- | --- | ------------------------------------------ |
| FIL-1 | DC-7        | Quarantine cleanup (`cleanup:once`) has no in-app scheduler entry; on the single app it never runs | P1  | add to `scheduled-sweeps.mjs` + fitness    |
| FIL-2 | ST-1        | Drive/OneDrive transports used by cloud import have no fetch timeout (`google-drive.google.ts:372`) | P1  | `AbortSignal.timeout` in the transports    |
| FIL-3 | QM-2 / ADR  | `MALWARE_SCAN_DRIVER=none` allowed in production; client files then only `checked`                 | P1  | ADR, or refuse `none` when clients exist   |
| FIL-4 | AR-5 / AR-7 | `files.module.ts` imports other modules' repositories and controller-file helpers (`:29-141`)       | P2  | read services / move helpers to services   |
| FIL-5 | AR-6        | `BlockedFilesController` uses a repository directly                                                 | P2  | move into `FilesService`                   |
| FIL-6 | HT-5        | Part-sink bearer token in the URL query                                                             | P2  | ADR or header                              |
| FIL-7 | DA-10       | 36 `current_timestamp(3)` row times                                                                 | P2  | bound `Date`                               |
| FIL-8 | AR-10       | `UploadSessionView` has no API/web pair                                                             | P2  | add pair                                   |
| FIL-10 | ST-4 / ops | Remote clamd (Oracle VM, SCANNER-TLS) is outside the repo: Hostinger's outbound IP or the stunnel cert changing makes the scanner `unreachable` (files wait, never `clean`); no circuit breaker, the probe-before-claim stops each pass | P2 | alert on `/healthz/deep` `scanner: unreachable`; runbook `D:/TManage/work/oracle-scanner/SETUP.md` §8 |
| FIL-9 | size        | `files.service.ts` is 2,199 lines, `files.module.ts` > 760 lines                                    | P2  | split per capability (upload, serve, purge)|

DC classes checked: DC-1 (API) none; DC-3 handled by claims and named locks; DC-4 not found
(ledger uses idempotency keys); DC-7 suspected (FIL-1).

## Glossary

| Term           | Meaning                                                                         |
| -------------- | ------------------------------------------------------------------------------- |
| Upload session | a quota reservation + part target; ends `ready`, `rejected`, `expired`, `cancelled` |
| Verify         | content-signature and archive checks before the malware scan                    |
| Checked        | client-visible label for a file that passed the checks but not a virus scan     |
| Quarantine     | rejected or blocked objects kept until the retention cutoff                     |
| Door           | the route family a caller enters by: staff, portal, public form, part sink      |
