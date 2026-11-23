---
part: api/audit
kind: api-module
context: audit-security-and-privacy
owner: implementation-lead
lifecycle: production
depends_on:
  [api-common/database, api-common/http, package/domain, package/config, app/worker, api/admin]
provides_api:
  [
    'GET /v1/organizations/:orgSlug/audit/events',
    'GET /v1/organizations/:orgSlug/audit/events/:eventId/changes',
    'GET /v1/organizations/:orgSlug/audit/events/export',
    'GET /v1/organizations/:orgSlug/audit/export.csv',
    'GET /v1/organizations/:orgSlug/admin/audit/integrity',
    'GET /v1/organizations/:orgSlug/admin/audit/catalog',
    'GET /v1/organizations/:orgSlug/admin/audit/export.sig',
  ]
consumes_api: []
tables_owned: [audit_events, audit_event_changes, audit_heads, audit_anchors, platform_audit_anchors]
rules:
  [
    DA-11,
    DA-1,
    DA-2,
    DA-3,
    DA-9,
    DA-10,
    DA-12,
    AR-5,
    AR-6,
    AR-7,
    AR-8,
    AR-10,
    AR-12,
    HT-1,
    HT-3,
    SE-1,
    SE-6,
    RT-1,
    ST-2,
    ST-5,
    ST-6,
    AS-6,
    OB-4,
    QM-2,
    PR-3,
    IP-5,
    UX-15,
  ]
ux_rules: [UX-15]
last_verified_commit: 3b7e4fa70eb6facff3f1dccc65c0867f0707a0a6
last_verified_date: 2026-11-20
last_verified_by: Claude Opus 5.5 (lane H)
---

# api/audit

Read this before changing any file under `apps/api/src/modules/audit/**`, or any code that writes
`audit_events`. Rule IDs refer to `docs/architecture/ENGINEERING-STANDARD.md` (AR, HT, DA, AS, ST,
RT, SE, OB, PR, QM), `IMPLEMENTATION-PATTERNS.md` (IP) and `UI-UX-DESIGN-STANDARD.md` (UX). Every
`file:line` was checked at `3b7e4fa7`. Paths are relative to this folder unless they start with
`apps/`, `e2e/`, `packages/`, `scripts/` or `docs/`.

## Purpose and bounded context

**What it is for.** Audit is the organization's **non-repudiation record** (DA-11; STRIDE "R"). It
owns four things:

1. _Writing_ an audit row in the caller's transaction, so a rolled-back change leaves no row
   (`audit.service.ts:16-23`, `record` at `:235-241`), plus two self-transacting variants:
   `recordStandalone` (`:249-254`) and the best-effort `recordDenial` (`:263-294`).
2. _Making the trail tamper-evident_: a per-organization SHA-256 hash chain written inside
   `AuditEventsRepository.append` (`audit-events.repository.ts:187-255`), a head row per
   organization (`audit_heads`), daily HMAC anchors written by the worker
   (`apps/worker/src/jobs/audit-anchor.ts:4-18`) and a read-only verifier
   (`audit-integrity.service.ts:80-182`).
3. _Reading_ it for people: the admin viewer (keyset pages of a narrow projection), the field-level
   before/after detail, two CSV exports and a signed export manifest. Since AI-PANEL (2026-11-23)
   also the member's own connected-AI tool calls (`AiActivityReader` in `ai-activity.service.ts`):
   only `mcp.tool_called` rows of the caller's own user and membership, identifiers only, read by
   the AI panel's `GET …/ai/activity` (AR-5: through this service, never the repository).
4. _The catalogue_ of actions with English and Arabic descriptions (`audit-catalog.ts:71-81`); the
   action list itself is `AUDIT_ACTIONS` in `packages/domain/src/policies/audit.ts:1789`.

**Who uses it.** 161 non-test files import `audit.service` (grep at `3b7e4fa7`; VIEWS §4 counts
189 imports). `CapabilityGuard` records every refusal (`apps/api/src/common/http/guards/capability.guard.ts:165`).
The web screens `AdminAuditScreen.tsx` and `components/admin/AuditIntegrityCheck.tsx` read it.

**Context map (VIEWS §4).** Audit is part of the **shared kernel** (with Identity, Tenancy and the
Platform outbox): every context is upstream of it as a writer.

| Direction | Partner | How | Evidence |
| --- | --- | --- | --- |
| upstream of | all modules | `AUDIT_SERVICE` from a `@Global()` module, one instance | `audit.module.ts:41-68`; registered `apps/api/src/app.module.ts:326,331` |
| bypassed by | 13 modules | `new AuditEventsRepository()` imported directly (AR-5) | e.g. `automations/webhooks.controller.ts:30,254,714`, `personal-access-tokens/org-tokens.controller.ts:15,66`, `mcp/mcp-call-audit.ts:8,147` |
| bypassed by | worker (5 stores) | raw `INSERT INTO audit_events` with `NOW(3)`, no chain, no metadata check | `apps/worker/src/common/database/timer-autostop-store.ts:36-39`, `lifecycle-store.ts:128-131`, `budget-burn-store.ts:42`, `retainer-store.ts:73`, `support-session-sweep-store.ts:58` |
| writes into | platform-admin | bumps `platform_support_sessions.actions_count` from the audit writer | `audit-events.repository.ts:105-106,260-262` |
| downstream of | admin (retention) | `admin/audit-retention-purge.ts:160` deletes old rows and calls `recordPurgeBoundary` | `audit-chain.repository.ts:120-138`; trigger `0358_audit_retention_purge.sql:1-26` |
| partner | worker | backfill + daily anchors; same signature format (golden vector) | `apps/worker/src/jobs/audit-anchor.ts:4-18`, `audit-chain.test.ts:89` |

## Domain model and invariants

**Entities.** `AuditEvent` (`audit_events`: id UUIDv7, organization, `actor_user_id`,
`effective_actor_id` for support-mode, `action`, `object_type` derived from the action,
`object_id`, `result` ∈ allowed|denied|error, `correlation_id`, `metadata_json`, `created_at`,
`ip`, `user_agent`, `platform_support_session_id`, `chain_seq`, `prev_hash`, `row_hash`).
`AuditEventChange` (`audit_event_changes`: field, before, after, redacted). `AuditHead` (one per
organization: `chain_seq`, `head_hash`, `legacy_last_event_id`, purge boundary). `AuditAnchor`
(one per organization per UTC day) and `PlatformAuditAnchor` (one per day).

**Value objects.** `AuditMetadata` checked by `assertSafeAuditMetadata` (identifiers and
classifications only); `AuditAction` (closed union from `@tmanage/domain`); chain version
`tmanage.audit.v1` (`audit-chain.ts:25`); genesis hash `sha256("tmanage.audit.genesis:<org>")`
(`audit-chain.ts:50-52`); anchor signature `v1:<keyId>:<hmac-hex>` (`audit-anchor-signer.ts:71-74`).

**Invariants (checkable)**

| # | Invariant | Where enforced | Proof |
| --- | --- | --- | --- |
| I-1 | No UPDATE on `audit_events`, ever; DELETE only for a row older than its own organization's stored retention window | triggers `0002_platform_primitives.sql:161-173`, replaced for DELETE by `0358_audit_retention_purge.sql:6-18`; `tmanage_app` holds INSERT only (`scripts/db/users.sql:1290`; worker INSERT `:1674`) | `apps/api/test/aud-001-audit.db.test.ts:199-235` |
| I-2 | `record` never opens a transaction; the row commits or rolls back with the caller's change | `audit.service.ts:235-241` (takes a `TenantQueryRunner` only) | `aud-001-audit.db.test.ts:494` ("leaves no audit row when the command rolls back") |
| I-3 | Organization and correlation id come from the context, never from input | `audit-events.repository.ts:224,234` | `aud-001-audit.db.test.ts:115` |
| I-4 | Metadata is checked **after** the channel stamp, before any SQL | `audit-events.repository.ts:145-157` | `aud-001-audit.db.test.ts:148,177` |
| I-5 | `security.capability_denied` and `file_asset.rejected` are only `denied`; `file_asset.scanned` only `allowed` | `audit-events.repository.ts:159-175` | `aud-001-audit.db.test.ts:164` |
| I-6 | Each API-written row has `chain_seq = head+1`, `prev_hash = head_hash`, `row_hash` over the stored row incl. `created_at`, under a `FOR UPDATE` lock on the head | `audit-events.repository.ts:197-255`, `audit-chain.repository.ts:69-96` | unit `audit-chain.test.ts:46,58`; **no db test** (§10) |
| I-7 | A principal without org-wide scope sees only their own activity, and cannot widen it by filter | `audit.service.ts:315-317` (overwrite last), `:381`, `:431-433` | `aud-001-audit.db.test.ts:352,359` |
| I-8 | The viewer and CSV never carry `metadata`, `correlationId` or `effectiveActorId` | projection `audit.service.ts:103-128,177-190`; CSV header `audit-export-csv.ts:31-39` | contract `_adminAudit` (`e2e/contracts/api-web-shapes.ts:2931`) |
| I-9 | An export is audited **before** a byte leaves; if that write fails, no CSV | `audit.controller.ts:120-132`, `audit-export.controller.ts:123-136` | `wave9-S8-export-audit.test.ts` |
| I-10 | A redacted change row stores neither value | `audit-redaction.ts:34-46,72-75`; read `audit.service.ts:385-390` | `audit-redaction.test.ts`, `apps/api/test/plat-011-audit-event-changes.db.test.ts` |
| I-11 | CSV cells that start a formula are prefixed with `'` | `packages/domain/src/export/csv.ts:36-40` | domain csv tests |

## Public API and contracts

All routes run behind the global chain (SE-1). The service re-checks the capability with
`hasCapability` from `@tmanage/domain` (defence in depth, same rule, so AR-8 holds).

| Method path | Capability | Success | Failures | File:line |
| --- | --- | --- | --- | --- |
| GET `/v1/organizations/:orgSlug/audit/events?limit&before&actorId&entityId` | `audit.read` | 200 `{events: AdminAuditEventView[]}`, newest first, keyset on id | 400 limit outside 1–50; 403 | `audit.controller.ts:34-69` |
| GET `…/audit/events/:eventId/changes` | `audit.read` | 200 `{changes}` | 404 unknown, other tenant, or another person's event for a narrowed principal | `audit.controller.ts:75-83`, `audit.service.ts:370-391` |
| GET `…/audit/events/export` | `audit.export` | 200 CSV attachment, `no-store`, `nosniff` | 403; **413** past 10,000 rows | `audit.controller.ts:101-138`; cap `audit.service.ts:207,454-462` |
| GET `…/audit/export.csv?from&to&actor&action` | `audit.export` | 200 CSV with `content-length` | 400 window missing, reversed or > 366 days; 413 | `audit-export.controller.ts:30,70-143` |
| GET `…/admin/audit/integrity` | `audit.read` **and** org-wide scope | 200 `AuditIntegrityReport` (`intact`/`broken`/`not_started`, `complete`) | 403 | `audit-integrity.controller.ts:27-34`, `audit-integrity.service.ts:80-83` |
| GET `…/admin/audit/catalog` | `audit.read` | 200 `{actions: AuditCatalogEntry[]}` | 403 | `audit-integrity.controller.ts:36-42` |
| GET `…/admin/audit/export.sig` | `audit.export` | 200 manifest `{chainSeq, headHash, lastEventId, generatedAt, signature}` | 403 | `audit-integrity.controller.ts:44-51`, `audit-integrity.service.ts:185-212` |

Status codes follow HT-1. 413 for an oversized export is a deliberate "narrow it" answer with a
field detail, not a silent truncation (`audit.service.ts:455-461`).

**Contracts (AR-10).** `_adminAudit = Assert<Exact<ApiAdminAuditEventView, WebAdminAuditEvent>>`
(`e2e/contracts/api-web-shapes.ts:2931`); `_auditIntegrityReport = Assert<Narrows<…>>` (`:4647`).
The comment at `:2921` says "seven fields"; the type has nine (`result`, optional `scanNote` added
later). Fix the comment when next touched. `AuditEventChangeEntry` and `AuditCatalogEntry` have
**no pair** (the web reads `…/changes` in `apps/web/src/lib/api/admin-audit.ts:52-59`).

**Exported services.** `AUDIT_SERVICE` (`AuditService`), `AUDIT_EVENTS_REPOSITORY` (exported at
`audit.module.ts:66`; this export is what lets other modules skip the service, see AUD-3),
`AUDIT_INTEGRITY_SERVICE`. Pure exports: `toAdminAuditView`, `EXPORT_MAX_ROWS`, `auditEventsToCsv`,
`redactChanges`, `canonicalJson`, `chainRowHash`.

**Events.** None published to `outbox_events`. Audit rows are not events and never replace one.

## Data: tables and migrations

| Table | Created | Later changes | Keys that matter | Retention |
| --- | --- | --- | --- | --- |
| `audit_events` | `0002_platform_primitives.sql:105-136` | `0241_audit_event_detail.sql:27-30` (ip, user_agent, support session); `0261_audit_chain.sql:27-30` (chain columns, `ix_audit_events_org_chain`); `0358` (delete trigger) | `uq_audit_events_org_id`; time/actor/object/action indexes (`0002:121-125`); **`(organization_id, chain_seq)` is a KEY, not UNIQUE** (`0261:30`) | kept forever unless the org stores a window (`audit_retention_policy`, owned by api/admin, `0148`) |
| `audit_event_changes` | `0241_audit_event_detail.sql:33` | delete guarded through parent (`0358`) | parent id | as parent |
| `audit_heads` | `0261_audit_chain.sql:32-43` | purge boundary columns (`0358`) | `uq_audit_heads_org (organization_id)` | one row per org |
| `audit_anchors` | `0261_audit_chain.sql:46-56` | — | `uq_audit_anchors_org_day` | daily, grows by 1/org/day (ST-6: no purge) |
| `platform_audit_anchors` | `0261_audit_chain.sql:59-67` | — | `uq_platform_audit_anchors_day` | daily |

**Grants (DA-9).** `tmanage_app`: INSERT on `audit_events` (`scripts/db/users.sql:1290`) and `audit_event_changes`
(`:1727`), INSERT, UPDATE on `audit_heads` (`:1996`). `tmanage_worker`: INSERT on `audit_events` (`:1674`);
SELECT, INSERT on `audit_heads`, `audit_anchors`, `platform_audit_anchors` (`:1999-2003`).

**Expand/contract (DA-6).** Every change above is additive and nullable. Rows written before 0261
are the **legacy prefix** (`legacy_last_event_id`); they stay unhashed by design
(`audit-chain.repository.ts:42-44`).

## Permissions and tenant rules

| Decision | Single owner | Consumers |
| --- | --- | --- |
| May read the trail | `audit.read` in `packages/domain/src/policies/capabilities.ts:75` | guard + `audit.service.ts:307,375`, `audit-integrity.service.ts:74` |
| May export (bulk egress) | `audit.export` (`capabilities.ts:76`), stronger than read | `audit.service.ts:421`, `audit-integrity.service.ts:186` |
| Org-wide vs own-activity | `principal.hasOrgWideScope` in `AuditService.view` | `:315-317`; same rule in export `:431-433` and changes `:381` |
| May run the chain check | `audit.read` + org-wide scope | `audit-integrity.service.ts:81` |

**Tenant scope (DA-12).** Every read filters `organization_id = context.organizationId` first
(`audit-events.repository.ts:276-278,325`, `audit-chain.repository.ts:89,147,178`); the view never
returns the organization id (`audit.service.ts:70-75`). A row from another tenant answers 404
exactly like a missing one (`audit-events.repository.ts:291-294`).

**Known gap (recorded in code).** The permission matrix asks for workspace, project and
client-side subsets; the table has no `workspace_id`, `project_id` or `client_organization_id`, so
the service takes the narrower reading (`audit.service.ts:40-53`).

**Trust zone.** Staff only. No client-portal route reads this module.

## Runtime, background work and failure modes

**Background work owned (runs in the worker and in-app via the shared list):** chain backfill and
daily anchors, `audit-anchors` in `apps/worker/src/jobs/scheduled-jobs.ts:91,147` (so DC-7 does
not apply). The key status is logged once when absent (`scheduled-jobs.ts:119`).

| Failure | Behaviour today | Rule | Verdict |
| --- | --- | --- | --- |
| DB down during a denial | `recordDenial` swallows, returns `false`; the 403 is still sent | HT-3 (deliberate, documented `audit.service.ts:25-38`) | correct; but the swallow is silent: add a warn log with correlation id (OB-4) |
| DB down during `record` | error propagates; caller's transaction rolls back | DA-11 | correct |
| Export audit write fails | export refused (no CSV) | QM-2 (security first) | correct, fails closed |
| Many writers in one org | every API audit write takes `SELECT … FOR UPDATE` on that org's head **inside the caller's transaction** and holds it to commit (`audit-chain.repository.ts:86-91`) | DA-1, DA-2, ST-5 | risk: all audited writes of one org serialise; a denial flood (`capability.guard.ts:165` awaits a write per 403) competes for the same lock. Needs a load/concurrency db test (AUD-6) |
| Two first writers race | `INSERT … ON DUPLICATE KEY UPDATE id = id` then re-select | DA-1 | correct (`audit-chain.repository.ts:49-65`) |
| Clock | `created_at` = DB `current_timestamp(3)` read under the lock and hashed (`:86`, `audit-events.repository.ts:240`); `toUtcDate` assumes the DB returns UTC (`audit-chain.repository.ts:29-33`) | DA-10 | deviation: DA-10 asks for a bound `Date`. Correct only while the pool's `time_zone` is UTC. ADR or bound date (AUD-5) |
| Integrity check on a big org | walks up to 100,000 rows in **one request** on the request pool, 500 per page (`audit-integrity.service.ts:30,131-147`) | AS-6, ST-2 | bounded and reports `complete=false`, but runs on the request path; move to a job with a cursor when orgs pass ~50k rows |
| Export over a narrow window in a big org | `export.csv` reads the **whole** trail up to 10,001 rows, then filters the window in memory (`audit-export.controller.ts:107-117`) | AS-6, HT-1 | defect AUD-2: a 1-day window in an org with > 10,000 events always gets 413 |
| Anchor key | read from `process.env` in the service constructor (`audit-integrity.service.ts:70`), not from the validated config | RT-1 | key *is* validated at boot (`packages/config/src/env.ts:504,932`); reading it twice is a second source; pass it through `API_CONFIG` |

## UX rules for its screens

n/a — API module. Its screens are owned by `web/org/admin` (`apps/web/src/app/[orgSlug]/admin/audit`,
`components/screens/AdminAuditScreen.tsx`, `components/admin/AuditIntegrityCheck.tsx`). Obligations
this API has towards them: (1) every decision the screen needs is in the answer (`result`,
`scanNote`, `complete`, `status`) so the web never infers it (AR-9); (2) **UX-15**: the Arabic action
descriptions are built in the API from a verb table (`audit-catalog.ts:21-69`) instead of the web
catalogs, and only for `en`/`ar` while the product ships seven locales. That is a UX-15 breach (AUD-7).

## Standards that apply

| Rule | Today | Target |
| --- | --- | --- |
| DA-11 append-only, chained, same tx | API path correct (I-1, I-2, I-6). **Worker writes bypass the chain and the metadata check** (5 stores, §1) | one writer: worker calls a shared chained append (port in `packages/` or an outbox event the API records) |
| DA-1 anomaly named | chain head: lost update prevented by `FOR UPDATE` row lock | keep; add the concurrency proof (AUD-6) |
| DA-2 write conflicts retried | relies on `TenantDatabase.transaction` retry (`apps/api/src/common/database/tenant-context.ts`) | db test with N parallel writers in one org |
| DA-3 bound params | Drizzle everywhere; `SQL_BUMP_SUPPORT_ACTIONS` bound (`audit-events.repository.ts:105-106`) | keep |
| DA-9 least privilege | INSERT-only on audit tables | keep |
| DA-10 time | DB clock, hashed (see §6) | AUD-5 |
| DA-12 tenant by query | org predicate first in every query | keep |
| AR-5 / AR-7 | 13 modules use the repository directly; audit writes `platform_support_sessions` (owner platform-admin) | stop exporting `AUDIT_EVENTS_REPOSITORY`; support counter via platform-admin service |
| AR-6 controllers → services | own controllers correct; two **other** controllers build `AuditEventsRepository` (`webhooks.controller.ts:254`, `org-tokens.controller.ts:66`) | fix with AUD-3 |
| AR-8 one decision | capabilities from `@tmanage/domain` only | keep |
| AR-10 paired shapes | viewer Exact, integrity Narrows; changes/catalog unpaired | add pairs |
| AR-12 exact types | `metadata as Record<string, unknown>` (`audit.service.ts:151`) after a type guard; acceptable | keep |
| HT-1 / HT-3 | 400/403/404/413 as defined; one documented swallow | log the swallowed denial |
| SE-1 | capability on every route | keep in route census |
| SE-6 STRIDE | repudiation row for the audit chain: not verified in `docs/security/threat-model.md` | add "worker bypass" row |
| RT-1 config | anchor key read from `process.env` (§6) | inject from config |
| ST-2 / AS-6 bounded work | page caps 50/200 (`audit-events.repository.ts:101-102`), export cap 10,000, verify cap 100,000 | push the export window into SQL (AUD-2) |
| ST-5 bulkhead | integrity walk on the request pool | job or read replica later |
| ST-6 steady state | `audit_events` grows forever unless an org sets a window; anchors grow daily | product decision: default retention window (ADR) |
| OB-4 correlation | correlation id on every API row (`audit-events.repository.ts:234`) | keep; worker rows pass one too |
| QM-2 | export fails closed | keep |
| PR-3 fix the class | the worker bypass is a class (5 writers), not one bug | fix all five together |
| IP-5 repository + UoW | `record` joins the caller's unit of work | keep |
| UX-15 | Arabic copy built in the API | AUD-7 |

## How to change this part

- **New audited action:** add it to `AUDIT_ACTION_CATALOG` in `packages/domain/src/policies/audit.ts`
  (the object type is derived from it), then call `AuditService.record(tx, context, …)` **inside the
  same transaction** as the change. Never `recordStandalone` for a state change. Metadata:
  identifiers and enums only (checked at `audit-events.repository.ts:157`). Field diffs go in
  `changes`; secrets are redacted by name (`audit-redaction.ts:34-46`), so name fields honestly.
- **Never** write `INSERT INTO audit_events` by hand (API or worker): it skips the chain, the
  metadata check and the support-mode stamps (PR-3, AUD-1).
- **New read:** a method on `AuditService` that goes through `view()` so the own-activity narrowing
  applies; a narrow projection; a contract pair in `e2e/contracts/api-web-shapes.ts` (AR-10).
- **New column:** additive, nullable, MariaDB-safe (DA-4..DA-6). If it is hashed, bump
  `CHAIN_VERSION` and teach the verifier both versions; never re-hash old rows (the triggers refuse).
- **Retention:** owned by `api/admin` (`admin/audit-retention-purge.ts`); it must call
  `recordPurgeBoundary` in the same transaction as the delete.
- Checks before commit: `pnpm --filter @tmanage/api typecheck` (includes `test/`), the unit tests
  in this folder, then the db suites in §10.

## Tests and fitness checks

- Unit (co-located): `audit.service.test.ts`, `audit-chain.test.ts` (hash determinism `:46`, verifier
  names first bad row `:58`, golden HMAC vector shared with the worker `:89`, catalog has en+ar
  `:109`), `audit-redaction.test.ts`, `audit-export.controller.test.ts`,
  `wave9-S8-export-audit.test.ts` (export audited, fails closed), `audit-viewer-b13.test.ts`.
- DB (`apps/api/test`): `aud-001-audit.db.test.ts` (23 cases: context stamping, append-only from
  the migration credential, tenant twin, narrowing, rollback leaves no row, denials),
  `plat-011-audit-event-changes.db.test.ts`.
- E2E: `e2e/tests/audit-journeys.spec.ts:40` (owner downloads the CSV); axe sweep
  `e2e/tests/a11y-audit.spec.ts` covers the admin audit screen (web side).
- Contract: `e2e/contracts/api-web-shapes.ts:2931,4647`.
- Fitness: DA-11 "INSERT-only grant proven in `least-privilege.db.test.ts`" (FITNESS-FUNCTIONS
  row DA-11); it needs a provisioned server and is skipped by the normal chain.
- **Missing:** (a) a db test for the chain itself: N parallel writers in one org → contiguous
  `chain_seq`, verifier `intact`; (b) a static check that no file outside this folder contains
  `INSERT INTO audit_events`; (c) a db test that `export.csv` with a narrow window works in an org
  with more than 10,000 rows.

## Open defects, decisions and risks

| Id | Class | Finding (verified at 3b7e4fa7) | Pri | Exit |
| --- | --- | --- | --- | --- |
| AUD-1 | DA-11 / PR-3 | 5 worker stores insert `audit_events` directly with `NOW(3)`: no chain, no `assertSafeAuditMetadata` (`timer-autostop-store.ts:36-39`, `lifecycle-store.ts:128-131`, `budget-burn-store.ts:42`, `retainer-store.ts:73`, `support-session-sweep-store.ts:58`). These rows land after the head, unhashed, and show only as `unchainedEvents`, never as a break | P1 | one chained writer shared by API and worker; static check (b) |
| AUD-2 | AS-6 / HT-1 | `export.csv` filters the date window in memory after reading up to 10,001 rows of the whole trail (`audit-export.controller.ts:107-117`), so a narrow window in a large org always answers 413 | P1 | pass `from`/`to`/`action` to `exportForViewer` and into the SQL predicate |
| AUD-3 | AR-5 / AR-6 | 13 modules import `AuditEventsRepository`; module exports `AUDIT_EVENTS_REPOSITORY` (`audit.module.ts:66`); two are controllers | P2 | callers use `AUDIT_SERVICE`; drop the export |
| AUD-4 | AR-7 | the audit writer updates `platform_support_sessions` (`audit-events.repository.ts:105-106,260-262`), a platform-admin table | P2 | platform-admin service or derived count |
| AUD-5 | DA-10 | row time from DB `current_timestamp(3)`, parsed as UTC by `toUtcDate` (`audit-chain.repository.ts:29-33,86`) | P2 | ADR naming the deviation + a db test that the pool `time_zone` is UTC, or a bound `Date` |
| AUD-6 | DC-5 risk | org-wide `FOR UPDATE` on the chain head inside every audited transaction; no concurrency test | P2 | test (a); measure lock wait under a denial flood |
| AUD-7 | UX-15 | Arabic action descriptions built from a verb table in the API (`audit-catalog.ts:21-69`), only en/ar | P2 | catalog keys in `apps/web/src/lib/i18n/messages/*`; API returns the action key only |
| AUD-8 | ST-6 | no default retention: `audit_events` (with ip/user agent) and `audit_anchors` grow without bound | P2 | product ADR on a default window |
| AUD-9 | doc | contract comment says seven fields, type has nine (`api-web-shapes.ts:2921`) | P3 | fix comment |

`(organization_id, chain_seq)` is not unique (`0261_audit_chain.sql:30`): duplicate positions are
prevented only by the head lock. The verifier would catch one; a UNIQUE key would prevent it (a
nullable column allows many NULLs, so the legacy prefix is unaffected). ADRs: ADR-0001 (tenant
isolation), ADR-0007 (least-privilege DB boundary).

## Glossary

| Term | Meaning |
| --- | --- |
| Chain head | the `audit_heads` row: last position and hash of an organization's chain |
| Legacy prefix | audit rows written before the chain started (0261); counted, never hashed |
| Anchor | daily signed snapshot of the head, so a rewrite of history after that day is detectable |
| Own-activity narrowing | a principal without org-wide scope sees only rows where they are the actor |
| Support mode | a platform admin acting inside a tenant; rows carry `effective_actor_id` and the support session |
| سجل التدقيق | audit log (Arabic UI term) |
