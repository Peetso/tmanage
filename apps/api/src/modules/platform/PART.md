---
part: api/platform
kind: api-module
context: platform-operations
owner: implementation-lead
lifecycle: production
depends_on:
  [
    api-common/database,
    api-common/http,
    package/domain,
    api/platform-admin,
    api/public-site,
    app/worker,
  ]
provides_api:
  [
    'GET /public/site/maintenance',
    'GET /v1/platform/maintenance',
    'POST /v1/platform/maintenance',
    'PATCH /v1/platform/maintenance/:windowId',
    'POST /v1/platform/maintenance/:windowId/publish',
    'POST /v1/platform/maintenance/:windowId/unpublish',
    'POST /v1/platform/maintenance/:windowId/end',
  ]
consumes_api: []
tables_owned: [outbox_events, maintenance_windows]
rules:
  [
    AS-1,
    AS-2,
    AS-3,
    AS-6,
    DA-1,
    DA-3,
    DA-9,
    DA-10,
    DA-11,
    DA-12,
    AR-5,
    AR-6,
    AR-7,
    AR-10,
    AR-12,
    HT-1,
    HT-3,
    SE-1,
    SE-3,
    RT-2,
    ST-6,
    OB-4,
    QM-2,
    IP-2,
    IP-5,
  ]
ux_rules: []
last_verified_commit: 3b7e4fa70eb6facff3f1dccc65c0867f0707a0a6
last_verified_date: 2026-11-20
last_verified_by: Claude Opus 5.5 (lane H)
---

# api/platform

Read this before changing any file under `apps/api/src/modules/platform/**`, before adding an
outbox event type, or before touching the sign-in maintenance gate. Rule IDs refer to
`docs/architecture/ENGINEERING-STANDARD.md` (AR, HT, DA, AS, ST, RT, SE, OB, QM),
`IMPLEMENTATION-PATTERNS.md` (IP) and `UI-UX-DESIGN-STANDARD.md` (UX). Every `file:line` was
checked at `3b7e4fa7`. Paths are relative to this folder unless they start with `apps/`, `e2e/`,
`packages/`, `scripts/` or `docs/`.

## Purpose and bounded context

**What it is for.** Two unrelated platform primitives live here:

1. **The transactional outbox writer** (PLAT-004, AS-1). `OutboxEventsRepository.append` inserts an
   `outbox_events` row with the caller's runner, so an event commits only with the state change it
   describes (`outbox-events.repository.ts:8-33` doc, `:51-76` code). The relay that claims,
   delivers, retries and parks is **not** here: it is `apps/worker/src/outbox/dispatcher.ts` with
   its own statements in `apps/worker/src/common/database/outbox-store.ts:4`.
2. **Platform maintenance windows** (x185, PA-10). A GLOBAL table (`maintenance_windows`, no
   organization) with a public read for the app shell's banner, an operator-only write surface
   behind `PlatformAdminGuard`, and the sign-in gate `assertSignInOpen` that refuses sign-in during
   a `down` window with "block sign-in" on (`maintenance.controller.ts:644-677`).

**Who uses it.** 55 non-test files import the outbox writer or `OUTBOX_EVENTS_REPOSITORY` (grep at
`3b7e4fa7`). The sign-in gate is called by `identity/authentication.controller.ts:399`,
`identity/passkeys/passkeys.controller.ts:300` and `portal-sign-in/portal-sign-in.controller.ts:161`.
The web reads the banner (`apps/web/src/lib/api/maintenance.ts:38-45`,
`components/screens/MaintenanceBanner.tsx`) and the operator page (`apps/web/src/app/platform`).

**Context map (VIEWS §4).** Platform (outbox) is in the **shared kernel** with Identity, Tenancy and
Audit; every context that emits an event is upstream of it.

| Direction | Partner | How | Evidence |
| --- | --- | --- | --- |
| upstream of | 55 producer files | `OUTBOX_EVENTS_REPOSITORY` from a `@Global()` module | `platform.module.ts:20-35`; `apps/api/src/app.module.ts:175,334` |
| supplier to | worker relay | rows in `outbox_events`; at-least-once delivery | `apps/worker/src/outbox/dispatcher.ts` |
| bypassed by | worker (3 stores) | raw `INSERT INTO outbox_events` with `NOW(3)` | `apps/worker/src/common/database/lifecycle-store.ts:164`, `signals-store.ts:109`, `notifications-store.ts:401-404` |
| shared kernel | `packages/domain` | event types, payload shapes, aggregate type | `packages/domain/src/events/outbox.ts:370,377,842` |
| conformist to | platform-admin | imports its guard, permission decorator, repository, SQL and audit insert | `maintenance.controller.ts:28-44`, `maintenance.repository.ts:8-12` |
| hosts | public-site | registers `PublicSiteAnnouncementsController` | `maintenance.controller.ts:619-626` |
| upstream of | identity, portal-sign-in | `assertSignInOpen` exported **from a controller file** | callers above |

## Domain model and invariants

**Outbox entities.** `OutboxEvent` (`outbox_events`: id UUIDv7, organization, `type`,
`schema_version`, `aggregate_type` derived from type, `aggregate_id`, `payload_json` = reference
envelope (ids and states, never content), `correlation_id`, `occurred_at`, `available_at`,
`published_at`, `attempts`, `last_error`; `0002_platform_primitives.sql:24-48`).

**Maintenance entities.** `MaintenanceWindow` (`message`, `message_ar`, `severity` ∈
info|degraded|down, `starts_at`, `ends_at`, `published`, `block_sign_in`, `ended_at`,
`created_at`, `updated_at`). Derived state machine `maintenanceState` (`maintenance.controller.ts:138-145`):
`ended` (ended or past) → else `draft` (unpublished) → else `active` (started) or `scheduled`.

**Invariants (checkable)**

| # | Invariant | Where enforced | Proof |
| --- | --- | --- | --- |
| I-1 | The outbox writer cannot open a transaction; it takes the caller's runner | `outbox-events.repository.ts:51-55` | `apps/api/test/plat-004-relay.db.test.ts` |
| I-2 | Organization and correlation id come from the context, never from input | `outbox-events.repository.ts:63,70` | `plat-004-relay.db.test.ts` |
| I-3 | Payload shape is fixed per event type at compile time | `AppendOutboxEventInput<T>` with `OutboxEventPayloads[T]` (`outbox-events.repository.ts:34-40`) | `pnpm typecheck` |
| I-4 | `organization_id` of an outbox row can never change | trigger `0002_platform_primitives.sql:141-148` | — |
| I-5 | A maintenance window has `starts_at < ends_at` and a severity from the closed list; a bad body is 400 with nothing written | `maintenance.controller.ts:251-287` (create), `:372-401` (edit); ENUM `0080_maintenance_windows.sql:41` | `maintenance.controller.test.ts:144,152,276`; `plat-001-maintenance-windows.db.test.ts:178` |
| I-6 | Every operator write commits with its `platform_admin_audit_events` row in one transaction | `maintenance.repository.ts:115-144,157-176`; `WRITE_TABLES` `:15` | `maintenance.controller.test.ts:118,164,259`; `plat-017-announcements-maintenance.db.test.ts:154` |
| I-7 | No organization role reaches the write routes; the old tenant route is gone | `@NoTenant() @UseGuards(PlatformAdminGuard)` `maintenance.controller.ts:214-216` | `maintenance.controller.test.ts:186,198` |
| I-8 | Only a published, not-ended `down` window with `block_sign_in = 1` blocks sign-in; platform admins pass | SQL `maintenance.repository.ts:336-339`, gate `maintenance.controller.ts:644-677` | `plat-017-announcements-maintenance.db.test.ts:205`; `maintenance.controller.test.ts:323,341` |
| I-9 | A draft window is never shown publicly | `toPublicMaintenance` filter `published && endsAt > now` | `plat-001-maintenance-windows.db.test.ts:197` |

## Public API and contracts

| Method path | Guard / permission | Success | Failures | File:line |
| --- | --- | --- | --- | --- |
| GET `/public/site/maintenance` | `@Public()`, identity read on a GLOBAL table | 200 `{window \| null, asOf}` | 5xx if DB down | `maintenance.controller.ts:179-204` |
| GET `/v1/platform/maintenance` | `PlatformAdminGuard` + `platform.orgs.view` | 200 `{windows ≤ 100, current, asOf}` | 404 for non-operators (guard) | `:224-238` |
| POST `/v1/platform/maintenance` | + `platform.announcements.edit`, typed reason **required** | 201 `MaintenanceWindowView` | 400 shape or missing reason | `:240-320`; reason `:289` |
| PATCH `/v1/platform/maintenance/:windowId` | same, reason **optional** | 200 | 400, 404 | `:348-422`; reason `:403` |
| POST `…/:windowId/publish` | same, reason optional | 200 | 404 | `:424-455`; `:435` |
| POST `…/:windowId/unpublish` | same, reason **required** | 200 `{unpublished: true}` | 400, 404 | `:322-345`; `:332` |
| POST `…/:windowId/end` | same, reason optional | 200 (sets `ends_at = least(ends_at, now)`, `ended_at`) | 404 | `:457-488`; SQL `maintenance.repository.ts:332-334` |

Also registered by `MaintenanceModule`: `GET /public/site/announcements`
(`PublicSiteAnnouncementsController`, owned by `api/public-site`).

**Contracts (AR-10).** `_maintenanceWindow`, `_publicMaintenance` Exact pairs
(`e2e/contracts/api-web-shapes.ts:3032-3033`); operator views Exact (`:3630,3633`).

**Exported services and functions.** `OUTBOX_EVENTS_REPOSITORY` (`platform.module.ts:24-33`);
`assertSignInOpen`, `maintenanceMessageFor`, `maintenanceState`, `toPublicMaintenance` (exported
from `maintenance.controller.ts`, see PLT-4).

**Events.** This module publishes nothing itself; it is the mechanism. The catalogue of event types
is `OUTBOX_EVENT_TYPES` in `packages/domain/src/events/outbox.ts:370`.

## Data: tables and migrations

| Table | Created | Later changes | Keys that matter | Retention |
| --- | --- | --- | --- | --- |
| `outbox_events` | `0002_platform_primitives.sql:24-48` | (none found; also touched by `0010`, `0020`, `0021` comments) | `uq_outbox_events_org_id`; relay index `ix_outbox_events_unpublished (published_at, available_at)`; **no `dedupe_key`** (AS-3) | **no purge of published rows found** in api, worker or server (grep for `DELETE FROM outbox_events`): grows forever (ST-6) |
| `maintenance_windows` | `0080_maintenance_windows.sql:35-54` | `0244_platform_flags_announcements.sql:80-84` (`message_ar`, `block_sign_in`, `updated_at`, `ended_at`) | `ix_maintenance_windows_published_ends (published, ends_at)` | kept; rows small, operator-written |

**Not owned but written here:** `platform_admin_audit_events` (owner `api/platform-admin`), through
`PLATFORM_SQL.insertAudit` imported from `platform-admin.repository.ts` (`maintenance.repository.ts:8-12,281-296`).

**Grants (DA-9).** `tmanage_app`: INSERT, UPDATE, **DELETE** on `outbox_events`
(`scripts/db/users.sql:338`); `tmanage_worker`: SELECT, INSERT, UPDATE (`:1583,1664`).
`maintenance_windows`: INSERT (`:1354`) and UPDATE (`:1358`) for `tmanage_app`, no DELETE. The
comment above `:1354` still says the write is "authorized by `org.manage`"; since wave 9 it is
`PlatformAdminGuard` (stale comment, PLT-8). The writer's own doc says the API "has no business"
claiming or deleting (`outbox-events.repository.ts:27-31`), yet `tmanage_app` holds UPDATE and
DELETE; whether the in-app relay needs them on the app credential is **not verified** (PLT-6).

**Expand/contract (DA-6).** 0244 is additive (nullable/defaulted columns).

## Permissions and tenant rules

| Decision | Single owner | Consumers |
| --- | --- | --- |
| Who may write maintenance windows | `PlatformAdminGuard` (allow-list `PLATFORM_ADMIN_EMAILS` or active `platform_admins` row, verified email, browser session, fresh step-up) + `RequirePlatformPermission` | `maintenance.controller.ts:214-216,225,242,324,350,426,459` |
| Is sign-in blocked now | `activeSignInBlock` SQL (`maintenance.repository.ts:266-277,336-339`) + `assertSignInOpen` | identity password sign-in, passkey, portal sign-in |
| Who passes a block | platform operators: allow-list or active platform admin, verified email (`maintenance.controller.ts:663-668`) | same |
| Tenant of an outbox row | `context.organizationId` (`outbox-events.repository.ts:63`) | relay; DA-12 |

**Tenant rules.** `maintenance_windows` is GLOBAL: read and written on the identity path with
`tables: ['maintenance_windows']` declared (`maintenance.controller.ts:191-194`,
`maintenance.repository.ts:72-73,115-116,180-181`); the tenant guard refuses a stray tenant table
(`plat-001-maintenance-windows.db.test.ts:295`). The outbox is tenant-scoped on write; only the
relay reads it cross-tenant, on its own credential.

**Trust zone.** Public (banner read), operator (writes), any principal (the sign-in gate). The
step-up for operator writes is decided inside `PlatformAdminGuard` (SE-3 lives in identity; the
guard asks it, see `api/identity` PART.md §5).

## Runtime, background work and failure modes

No background work runs in this module. The relay and its health (`apps/worker/src/outbox/health.ts`),
backoff (`backoff.ts`) and parking at `OUTBOX_MAX_ATTEMPTS` (`outbox-store.ts:65,90-91`) are the
worker's.

| Failure | Behaviour today | Rule | Verdict |
| --- | --- | --- | --- |
| Producer retries a command | a second `append` is a second row; consumers dedupe on `id` only (`0002:22`) | AS-2, AS-3 | gap: a retried request (new id) enqueues twice. Needs `dedupe_key` (PLT-1) |
| DB down on the public read | error propagates (5xx); web must render unknown, not "no maintenance" | HT-3 | correct on the API side |
| DB down in the sign-in gate | `catch { return; }`: **sign-in is allowed** (`maintenance.controller.ts:653-660`) | HT-3, QM-2 | deliberate fail-open (test `maintenance.controller.test.ts:360` "or the read fails"); no ADR names it. A block window is availability policy, not a security control, so fail-open is defensible, but the swallow is silent (PLT-3) |
| Two operators edit one window | `find` then `update` in separate statements (`maintenance.controller.ts:358-419`); last writer wins | DA-1 | lost update possible; low traffic. Conditional update on `updated_at` (PLT-5) |
| Public read, second query | `repository.find` runs a second identity read for `messageAr`, guarded by `typeof this.repository.find === 'function'` (`:196-201`) | IP-2, AR-12 | `listPublishableWindows` (`maintenance.repository.ts:44-55`) reads the Drizzle columns only, so `message_ar` costs a second query; select it in the first read and drop the duck-typing |
| Two instances | the guard and repository are stateless; `MaintenanceModule` builds a **second** `PLATFORM_ADMIN_LOOKUP` provider (`:601-605`) besides the platform-admin module's | RT-2 | harmless when duplicated (stateless) |
| Clock | `occurred_at`/`available_at` from DB `current_timestamp(3)` (`outbox-events.repository.ts:71-72`); window `created_at`/`updated_at` likewise (`maintenance.repository.ts:84,127,328`) | DA-10 | deviation from "bound `Date`"; `available_at` vs the relay's `now` must use the same clock, which the DB clock guarantees. Document in an ADR rather than change |

## UX rules for its screens

n/a — API module. The banner (`MaintenanceBanner.tsx`) belongs to the web app shell; the operator
page belongs to `apps/web/src/app/platform`. Obligations of this API: the Arabic message rides in
`messageAr` and the sign-in refusal picks the language from `Accept-Language`
(`maintenanceMessageFor`, `maintenance.controller.ts:171-177`); the public answer carries `active`
so the banner never computes it from times (AR-9 spirit).

## Standards that apply

| Rule | Today | Target |
| --- | --- | --- |
| AS-1 outbox | writer correct and transactional (I-1) | keep; no inline sends in handlers |
| AS-2 idempotent consumers | consumers key on event `id` (worker) | keep |
| AS-3 dedupe key | **absent**: `outbox_events` has PK + `(organization_id, id)` only | expand migration: nullable `dedupe_key` + `UNIQUE (organization_id, dedupe_key)`; `append` takes it |
| AS-6 bounded work | relay pages and parks (worker) | keep |
| DA-1 | maintenance edit is read-then-write without a guard | conditional update |
| DA-3 | bound params everywhere (`maintenance.repository.ts:323-339` placeholders) | keep |
| DA-9 | app holds UPDATE/DELETE on outbox beyond the writer's need | prove the need or revoke (PLT-6) |
| DA-10 | DB clock (see §6) | ADR |
| DA-11 | operator writes audited in the same tx (I-6) | keep |
| DA-12 | outbox org from context | keep |
| AR-5 / AR-7 | writes `platform_admin_audit_events` with platform-admin's SQL; imports its guard and repositories | move maintenance into `platform-admin` (it is an operator feature) or call a platform-admin audit service |
| AR-6 | controllers inject repositories (`maintenance.controller.ts:181-185,219-221`) and `TENANT_DATABASE` | `MaintenanceService` between them |
| AR-10 | four Exact pairs | keep |
| AR-12 | `String(row['severity']) as …` (`maintenance.repository.ts:357`) | parse with `asSeverity` |
| HT-1 | 201 create, 200 others, 400/404 | keep |
| HT-3 | sign-in gate swallows DB errors silently | log at warn with correlation id (OB-4) |
| SE-1 | guard + permission on every write | keep in the platform route census |
| SE-3 | step-up through `PlatformAdminGuard` | keep |
| RT-2 | stateless | keep |
| ST-6 | outbox never purged | purge published rows older than N days in a leased sweep (AS-4) |
| QM-2 | fail-open sign-in gate | ADR that records the trade |
| IP-2 parse once | hand-written `as*` parsers in the controller (`maintenance.controller.ts:545-582`) | one zod schema for the body |
| IP-5 | outbox joins the caller's unit of work | keep |

## How to change this part

- **New event type:** add it to `OUTBOX_EVENT_CATALOG` and `OutboxEventPayloads` in
  `packages/domain/src/events/outbox.ts` (ids and states only), call
  `outbox.append(tx, context, {type, aggregateId, payload})` inside the producer's transaction, and
  add the consumer in `apps/worker/src/outbox/` (idempotent on event id, AS-2). Never insert
  `outbox_events` by hand (worker stores included, PLT-2).
- **Maintenance feature:** new field → additive migration (DA-4..DA-6), the record type, both
  views, the contract pair (`api-web-shapes.ts:3630`); every write keeps the platform audit row in
  the same `identityTransaction` with `WRITE_TABLES` declared.
- **Grants:** any new table or statement here changes `scripts/db/users.sql` in the same commit (DA-9).
- Checks: `pnpm --filter @tmanage/api typecheck`, `maintenance.controller.test.ts`, then
  `plat-001-maintenance-windows.db.test.ts`, `plat-017-announcements-maintenance.db.test.ts`,
  `plat-004-relay.db.test.ts`.

## Tests and fitness checks

- Unit: `maintenance.controller.test.ts` (18 cases: public read, schedule with audit row, 400 without
  reason, severity and time order, unpublish 404, no tenant route, guard refuses an owner, PATCH
  merge and audit, End now, sign-in gate in Arabic, platform admins pass, fail-open on read error).
- DB (`apps/api/test`): `plat-001-maintenance-windows.db.test.ts` (8 cases incl. ENUM refusal and
  identity-path scope), `plat-017-announcements-maintenance.db.test.ts` (sign-in block, End now,
  degraded never blocks), `plat-004-relay.db.test.ts` (writer + relay), plus every producer's db
  suite (e.g. `notif-001-notifications.db.test.ts`, `file-002-scanning.db.test.ts`).
- Worker: `apps/worker/src/outbox/*.test.ts` (backoff, claim attempts, effects, health).
- Contract: `e2e/contracts/api-web-shapes.ts:3032-3033,3630,3633`.
- Fitness (FITNESS-FUNCTIONS): AS-1 outbox tests (E) + lint "no `@tmanage/mail`/`fetch` in
  controllers or services outside adapters" (B); AS-3 "same `dedupe_key` twice → one row" (B, blocked
  on the column).
- **Missing:** a static check that no file except `outbox-events.repository.ts` inserts
  `outbox_events`; a db test that a retried producer does not double-deliver.

## Open defects, decisions and risks

| Id | Class | Finding (verified at 3b7e4fa7) | Pri | Exit |
| --- | --- | --- | --- | --- |
| PLT-1 | AS-3 / DC-4 | no `dedupe_key` on `outbox_events`; `append` has no key parameter (`outbox-events.repository.ts:34-40`) | P1 | expand migration + key in `append` for producers that can repeat |
| PLT-2 | AR-7 / PR-3 | 3 worker stores insert `outbox_events` with hand SQL and `NOW(3)` (`lifecycle-store.ts:164`, `signals-store.ts:109`, `notifications-store.ts:401`) | P2 | shared writer for the worker; static check |
| PLT-3 | HT-3 / QM-2 | sign-in gate fails open silently on a DB error (`maintenance.controller.ts:653-660`) | P2 | warn log + ADR recording the trade |
| PLT-4 | AR-6 / AR-5 | controllers hold repositories and `TENANT_DATABASE`; `assertSignInOpen` (domain decision) is exported from a controller file and builds repositories inline (`:644-669`) | P2 | `MaintenanceService` exported by the module; identity injects it |
| PLT-5 | DA-1 | PATCH is read-then-write, last writer wins | P3 | `WHERE updated_at <=> ?` |
| PLT-6 | DA-9 | `tmanage_app` holds UPDATE, DELETE on `outbox_events` (`users.sql:338`) beyond the writer's needs | P2 | find the user (in-app relay?) or revoke |
| PLT-7 | ST-6 | published outbox rows are never purged | P2 | leased purge sweep |
| PLT-8 | doc | `users.sql` comment above `:1354` names `org.manage`; reason is required for schedule/unpublish but optional for edit/publish/end, while the class doc says "every write needs a typed reason" (`maintenance.controller.ts:62-66`) | P3 | align the doc or require the reason everywhere |
| PLT-9 | AR-7 | maintenance writes `platform_admin_audit_events` with platform-admin's SQL (`maintenance.repository.ts:281-296`) | P2 | platform-admin audit service, or move the feature into platform-admin |

ADRs: ADR-0001 (tenant isolation), ADR-0007 (least-privilege DB boundary), ADR-0010 (overlapping
instances).

## Glossary

| Term | Meaning |
| --- | --- |
| Outbox | table of events committed with their cause and delivered later by the relay |
| Relay / dispatcher | the worker loop that claims, delivers, retries and parks outbox rows |
| Parked | an outbox row that reached the attempt cap: kept, reported, never claimed again |
| Maintenance window | a published period with a banner; `down` + block sign-in stops sign-in for non-operators |
| وضع الصيانة | maintenance mode (Arabic UI term) |
