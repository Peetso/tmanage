---
part: app/worker
kind: app-runtime
context: platform-operations
owner: implementation-lead
lifecycle: production
depends_on: [api-common/database, package/domain, package/config, package/mail, package/contracts]
provides_api:
  [
    '@tmanage/worker (library exports, apps/worker/src/index.ts)',
    'CLI: --once --status --unpark --sweep-* --rotate-keys (apps/worker/src/main.ts)',
    'WebSocket /realtime (standalone REALTIME_PORT or attached in apps/server)',
  ]
consumes_api: []
tables_owned: []
rules:
  [
    AS-1,
    AS-2,
    AS-3,
    AS-4,
    AS-6,
    DA-1,
    DA-2,
    DA-3,
    DA-12,
    ST-1,
    ST-2,
    ST-4,
    ST-5,
    ST-6,
    RT-2,
    RT-3,
    RT-6,
    RT-7,
    RT-8,
    OB-2,
    OB-4,
    PR-1,
    IP-17,
  ]
ux_rules: []
last_verified_commit: 3b7e4fa70eb6facff3f1dccc65c0867f0707a0a6
last_verified_date: 2026-11-20
last_verified_by: Claude Opus 5.5 (lane E)
---

# app/worker: the outbox relay and job runtime

Scope (PART-DOCS §3.2): this doc covers the **runtime only**: the dispatcher, the queue protocol (reserve, claim, publish, backoff, park, unpark), after-commit effects, the sweep lock, the scheduled-job list shape, the worker DB handle, process modes and shutdown. What each consumer, job or sweep **does** is documented in the owning module's `PART.md` §6. The ownership table below is the hand-off list until `parts.json` fixes owners.

## Purpose and bounded context

The worker delivers side effects that a request committed to the transactional outbox (AS-1): notifications, mail, realtime frames, webhooks and automation runs. It also hosts the recurring jobs. It runs in two hosts:

1. **Standalone process** (`apps/worker/src/main.ts`; scripts in `apps/worker/package.json`). The polling loop runs until SIGINT/SIGTERM (`main.ts:135-136`, `:695-698`); one-shot modes are `--once`, `--status`, `--unpark`, `--sweep-*` and `--rotate-keys` (RT-8; `main.ts:110-136`).
2. **Inside the single Hostinger app.** Live runs this host, `WORKER_INPROCESS=1` (`deploy/hostinger/.env.example:160`). `apps/server/server.mjs:335-494` imports `@tmanage/worker` and drives `runOutboxBatch`/`runQueueBatch` itself. The sweeps and jobs are driven by `apps/server/scheduled-sweeps.mjs`.

Context map: the worker is **downstream (conformist) of every producing context**. It consumes the event types in `apps/worker/src/consumers/registry.ts:122-300`. It is a shared-kernel user of `packages/domain` (`@tmanage/domain/field-cipher`, `scheduled-jobs.ts:16`) and `packages/mail`. It shares the database with the API but has its **own credential** `tmanage_worker`: SELECT/INSERT/UPDATE on the tables it touches, DELETE on nothing (`worker-database.ts:12-23`; DA-9).

## Domain model and invariants

**Queue item lifecycle** (`outbox_events` and the credential-notice queue share one protocol, `dispatcher.ts:177-208`):

`pending (published_at NULL, attempts < max)` → **reserve** (tx 1: `FOR UPDATE SKIP LOCKED`, `attempts += 1`, commit; `outbox-store.ts:97-110`) → **claim + handle** (tx 2, one savepoint per event; `outbox-store.ts:182-194`, `:577`) → `published` (`markPublished`, `:213`) | `failed` (`recordFailure`, `available_at = now + backoff`, `:226`) → `parked` once `attempts ≥ OUTBOX_MAX_ATTEMPTS` (default 8, `packages/config/src/env.ts:418`). A parked row is never claimed (`outbox-store.ts:106`) and leaves only through `--unpark` (`unparkEvents`, `:432`).

| # | Invariant (checkable) | Where | Proof |
| --- | --- | --- | --- |
| W-1 | An attempt is counted on durable storage **before** any handler runs, so a handler that kills the process costs its row one attempt, and a poison row parks instead of stalling the queue. | `dispatcher.ts:26-44`, `:290-295` | `claim-attempts.test.ts:246`, `:259` |
| W-2 | A whole-batch failure for an enumerated infrastructure reason (1205, 1213, 1969, connection codes) refunds the reserved attempts. Any other error keeps them. | `outbox-store.ts:515-522`, `:555` (`isRecoverableBatchError`), `dispatcher.ts:404` | `claim-attempts.test.ts:374`, `:395`, `:410`, `:424` |
| W-3 | The handler whose own deadlock lost the batch keeps its attempt, so it parks rather than loops. | `dispatcher.ts:285-288` | `claim-attempts.test.ts:437` |
| W-4 | After-commit effects run only once the batch transaction has committed. A rolled-back savepoint discards its effects. A failing effect does not un-publish its event. | `dispatcher.ts:83-120` | `effects.test.ts:118`, `:143`, `:202`, `:224` |
| W-5 | An event type with no handler is published to zero consumers, not held. | `dispatcher.ts:54-61`, `:308-317` | `claim-attempts.test.ts:342` (publish once) and dispatcher reports `unhandled` |
| W-6 | Two relays never take the same row: `FOR UPDATE SKIP LOCKED` on reserve and claim. | `outbox-store.ts:109`, `:194` | `apps/api/test/plat-004-relay.db.test.ts` |
| W-7 | The backlog aggregate runs outside the batch transaction, so its full scan holds no row locks. | `dispatcher.ts:244-250`, `outbox-store.ts:329` | `claim-attempts.test.ts:565` |
| W-8 | Per-event retry is exponential, `base · 2^(attempts−1)`, capped (defaults 1 s / 15 min). The loop-error delay adds ≤ 25 % jitter. | `backoff.ts:8-14`; `dispatcher.ts:471-488` | `backoff.test.ts`; `claim-attempts.test.ts:514`, `:522` |
| W-9 | A sweep runs only while this process holds `GET_LOCK('<schema>:sweep:<name>', 0)`. A second pass of the same name in the same process is skipped. The lock is released after the pass, even when the pass throws. | `sweep-lock.ts:33-62` | `sweep-lock.test.ts:40`, `:50`, `:74` |
| W-10 | Every recurring job is defined once in `createScheduledJobs`, and both hosts build from that list (DC-7). | `jobs/scheduled-jobs.ts:1-12`, `:139-260` | `scheduled-jobs.test.ts:34`; `apps/server/scheduled-sweeps.test.mjs:549` |
| W-11 | No statement on the worker pool can run longer than `DATABASE_STATEMENT_TIMEOUT_MS` (15 s default, `env.ts:278`): `SET SESSION max_statement_time` runs on every new connection. | `worker-database.ts:72-90`, `:176` | `worker-database.test.ts` |
| W-12 | SQL and driver handles exist only under `src/common/database/` (lint allowlist). | `worker-database.ts:6-10` | `eslint.config.js` allowlist; `upsert-affected-rows.guard.test.ts` |
| W-13 | DC-3 / RT-3 leader lease: at most one copy wins `runtime_leases` (one conditional UPDATE `WHERE holder = me OR expires_at < now`); the holder trusts it only until `start + ttl − renew` on the monotonic clock (30 s / 10 s); a query error is its own outcome; every time is a bound JS Date. | `common/database/runtime-lease-store.ts`, `leadership/leader-lease.ts` | `leader-lease.test.ts`, `runtime-lease-store.test.ts`, `apps/api/test/rt-003-leader-lease.db.test.ts` |

## Public API and contracts

**Library** (`apps/worker/src/index.ts`, used by `apps/server` and the API db suite). Exports include `createWorkerDatabase` (`:9`), `createSweepLock`/`createSweepLockDatabase` (`:11-12`), `backoffDelayMs` (`:57`), the sweep functions and their stores (`:58-99`), the health readers (`:100-127`), the consumer registry and mailers (`:144-193`), and `RealtimeHub` (`:196`). The dispatcher API is `runOutboxBatch` (`dispatcher.ts:262`), `runQueueBatch` (`:274`), `runOutboxLoop` (`:489`) and `runQueueLoop` (`:502`). The health API is `evaluateOutboxHealth` (`health.ts:115`), `writeHeartbeat` (`:238`, temp file + rename, `:289`) and `readHeartbeat` (`:298`).

**Events consumed:** the published language is `packages/contracts` (event schemas) plus the `type` strings in `consumers/registry.ts:176-292` (`work_item.*`, `message.created.v1`, `direct_message.created.v1`, `meeting.*`, `approval.*`, `review.*`, `client_request.*`, `usage.threshold_reached.v1`, `storage_connection.root_at_risk.v1`, `work_signal.raised.v1`, `privacy_*`). A new type without a handler is published and dropped (W-5). Adding a consumer later therefore needs a replay or projection step.

**CLI** (RT-8): `relay:once`, `relay:status` (exits 1 when not ok, `main.ts:409`), `relay:unpark`, `sweep:invitations`, `sweep:deferred-requests`, `sweep:due-soon` and `keys:rotate` (`package.json` scripts).

**Config** (all from `@tmanage/config`, `main.ts:138-140`): `OUTBOX_BATCH_SIZE` 25 (≤ 500), `OUTBOX_MAX_ATTEMPTS` 8 (≤ 50), `OUTBOX_POLL_INTERVAL_MS` 500, `OUTBOX_BACKOFF_BASE_MS` 1000, `OUTBOX_BACKOFF_CAP_MS` 900000 (`packages/config/src/env.ts:415-424`), plus `OUTBOX_HEARTBEAT_FILE`/`_MAX_AGE_SECONDS`, `WORKER_DATABASE_URL` and `DATABASE_POOL_MAX`.

## Data: tables and migrations

The runtime **owns no table**. `outbox_events` is owned by `api/platform` (`apps/api/migrations/0002_platform_primitives.sql:20-50`). Columns the runtime depends on: `published_at`, `available_at`, `attempts`, `last_error` (≤ 1000), `correlation_id`, and the claim index `ix_outbox_events_unpublished (published_at, available_at)`. That is the one index not led by `organization_id`, because the relay is deliberately cross-tenant (`0002:44-47`). The credential-notice queue table belongs to identity (`0020_credential_change_notices.sql`). The ~55 `*-store.ts` files under `src/common/database/` read and write tables that **other contexts own**. Each store is an adapter of its owning module and must be listed in that module's `PART.md` (AR-7).

**Missing:** there is no producer dedupe key on `outbox_events` (grep `dedupe_key` in the outbox migrations finds none), so AS-3 is unmet (DC-4). There is no `job_runs` table, so AS-4 run records are unmet. RT-3: `runtime_leases` (0384, lane K) holds the leader lease; the worker credential has SELECT, INSERT, UPDATE on it (`scripts/db/users.sql`).

## Permissions and tenant rules

- **No tenant guard on this pool, by design** (`worker-database.ts:12-23`). The relay's claim is the canonical unscoped statement. What replaces the guard: (1) the `tmanage_worker` grants (`scripts/db/users.sql`, no DELETE); (2) every per-event statement in a store carries the event's own `organization_id`; (3) the db suite asserts that a consumer cannot cross tenants. This is a **documented bend of DA-12**. It has no ADR yet, and PR-2 requires one.
- Payloads are reference envelopes, never content copies. Consumers re-resolve objects through tenant-scoped reads (`0002:31-33`).
- Mail from consumers passes the send ceiling and bounce suppression (`apps/server/server.mjs:388-400`). Privacy and credential notices stay transactional.

## Runtime, background work and failure modes

**Pools (ST-5):** the standalone pool is `min(DATABASE_POOL_MAX, 3)` in loop mode, otherwise 2 (`worker-database.ts:137-139`), with `waitForConnections: true` (`:170`) and **no `queueLimit`**, so mysql2's default of 0 means an unbounded wait queue (ST-2 gap). The sweep lock has its own 1-connection pool (`sweep-lock.ts:72-80`).

**Standalone loops** (`main.ts:703-835`): the support-session sweep, person mail (locked), activity projector (locked), signals (locked), export jobs, mail drain, webhook retries, one loop per scheduled job (locked, `:763`), the outbox loop (`:807`) and the notice queue loop (`:832`). Shutdown (`main.ts:695-698`, `:850-871`) aborts one `AbortController`, awaits every loop's in-flight pass, then ends the pools. This is RT-6 for the standalone host.

**Ownership hand-off (for the owning `PART.md` §6, to confirm in `parts.json`):**

| Worker code | Proposed owner part |
| --- | --- |
| `consumers/collaboration-notices`, `direct-message-notices`, `work-item-mention-notices`, `notifications/*`, `jobs/notification-digest` | api/notifications |
| `consumers/automation-runs`, `jobs/due-soon-sweeper` | api/automations |
| `consumers/work-item-lifecycle`, `work-blocked-notification`, `work-signal-notice`, `jobs/signals-sweeper` | api/work, api/insights |
| `consumers/client-request-*`, `jobs/request-defer-sweeper` | api/requests |
| `consumers/review-notices` | api/files |
| `consumers/privacy-mail`, `jobs/purge-*`, `jobs/content-purge-entry` | api/privacy, api/platform-admin |
| `consumers/usage-threshold-*`, `storage-root-at-risk`, `jobs/storage-root-check` | api/files, api/storage-root |
| `consumers/webhook-deliveries`, `jobs/webhook-retry-sweeper`, `channel-*` | api/connectors |
| `consumers/link-previews` | api/unfurl |
| `jobs/budget-burn-sweeper`, `retainer-period-roll` | api/projects or api/finance |
| `jobs/finance-facts-rebuild`, `einvoice-chain-reconciler` | api/finance |
| `jobs/growth-rollup` | api/platform-admin |
| `jobs/audit-anchor`, `approval-chain-walk` | api/audit, api/approvals |
| `jobs/security-detector`, `security-report-purge`, `ip-lookup-sweeper`, `support-session-sweeper`, `field-cipher-rotation` | api/security-signals, api/security-reports, api/identity, api/platform-admin |
| `jobs/activity-projector` | api/activity |
| `jobs/timer-autostop` | api/time |
| `invitations/invitation-sweep` | api/tenancy |
| `realtime/*` | api/realtime |

**Failure modes:**

| Failure | Behaviour today | Pattern | Gap |
| --- | --- | --- | --- |
| Handler throws | savepoint rollback, `recordFailure`, backoff, park at cap (W-1..W-3) | Retry + dead letter (AS-6) | per-event backoff has **no jitter** (`backoff.ts:8-14`; DA-2 asks for jitter) |
| Deadlock or lock wait in a batch | refund + retry the batch (W-2) | DA-2 | **1020 `ER_CHECKREAD` is not in `RECOVERABLE_ERRNOS`** (`outbox-store.ts:515-522`). Under MariaDB 11.8 `innodb_snapshot_isolation=ON` (DC-5), a contended batch keeps its attempts and can park. This is a fourth local retry policy, not the shared helper. |
| Statement over 15 s | killed with 1969, treated as recoverable | ST-2 timeout | ok |
| DB unreachable | loop error delay grows exponentially with jitter (`dispatcher.ts:471-488`) | backoff | ok |
| SMTP or third party slow or down | consumer fails → retry/park | ST-1, ST-4 | timeouts live in `packages/mail` and each adapter; there is **no circuit breaker** (ST-4, ENGINEERING-STANDARD §7: "None found") |
| Two relays (restart overlap) | SKIP LOCKED (W-6) | RT-2 | ok for delivery. **Realtime hub is per process** (`realtime/hub.ts:4-10`), so frames go only to that process's sockets (DC-3) |
| Two sweep runners | named lock per pass (W-9) | AS-4 | `GET_LOCK` NULL (error) is treated as held (`sweep-lock.ts:51`) and **skipped silently** (DC-1 class). Throttle state for some jobs is in memory in `apps/server` |
| Relay wedged | heartbeat goes stale → `/healthz/deep` `worker: fail` (`apps/api/src/common/observability/deep-health.ts:139-143`) and an alert mail | RT-11 (partial) | heartbeat is a file, so either process can satisfy it (DC-3 P2) |

**Logging:** `console.warn`/`console.error` text lines (`main.ts:142-145`, "OBS-001 is the structured-logging ticket"). RT-7 and OB-2 are unmet. The correlation id is read from the row (`outbox-store.ts:22`, `:206`) but is not put on log lines, so OB-4 is only half done.

## UX rules for its screens

n/a — the worker renders no screen. The mail it sends follows the copy rules of the owning modules' templates (`packages/mail`, `notifications/*`).

## Standards that apply

| Rule | Today | Target |
| --- | --- | --- |
| AS-1 | outbox written in the producer's transaction (`0002:20-22`); the relay delivers | met |
| AS-2 | consumers dedupe on event id or a business key. Notifications are INSERT-only with a unique key (ARCH-REVIEW DC-4) | each consumer's `PART.md` names its key |
| AS-3 | no `dedupe_key` on `outbox_events` | expand migration: `dedupe_key` UNIQUE per org |
| AS-4 | named lock per pass; no run records | `job_runs` table; three lock outcomes |
| AS-6 | bounded batches, backoff, park, `--unpark`, `--status` | add per-run record and admin-visible dead letters |
| DA-1/DA-2 | lock order implicit (reserve, then claim, by `(available_at, id)`); local recoverable list without 1020 | shared `withWriteConflictRetry()` (1020, 1213, 1205) with jitter |
| DA-3 | bound parameters (`sweep-lock.ts:30-32`, stores) | met |
| DA-12 | bent: unscoped pool, bounded by grants (§5) | ADR naming the compensating control |
| ST-1 | outbound calls inside consumers and mailers | audit each adapter for `AbortSignal.timeout` |
| ST-2 | statement timeout set; pool size bounded; **queue unbounded** | `queueLimit` + acquire timeout |
| ST-4 | none | breaker per integration (SMTP, webhooks, AI) |
| ST-5 | separate pools per role | met |
| ST-6 | heartbeat file overwritten; parked rows stay forever | purge or archive policy for published and parked outbox rows |
| RT-2/RT-3 | leader lease (W-13) gates the in-app relay, sweeps and jobs; SKIP LOCKED + named locks stay; hub per process. The standalone `main.ts` does not take the lease (live runs only the in-app host) | realtime fan-out; lease in `main.ts` if a standalone worker ever runs beside the app |
| RT-6 | standalone: abort + await every loop (`main.ts:850-871`) | met here; the in-app host is covered in app/server |
| RT-7, OB-2, OB-4 | text logs, no spans | JSON lines with correlation and instance id; one span per delivery and job run |
| RT-8 | one-off modes from the same build | met |
| IP-17 | job shape: one bounded pass, a log line or `null`, schedule checked inside the pass under the lock (`scheduled-jobs.ts:9-12`) | met for the list jobs |
| PR-1 | DC-7 fitness test in apps/server; dispatcher well covered | add a 1020 test and a NULL-lock test |

## How to change this part

- **New consumer:** write it in `src/consumers/<name>.ts`, with SQL only in a `src/common/database/<name>-store.ts`. Register it in `createWorkerOutboxHandlers` (`consumers/registry.ts:122`). Key its effect on a UNIQUE business key (AS-2, never a timestamp). Put any send in an **after-commit effect** (W-4). Add a unit test with a fake store and a db test in `apps/api/test/*.db.test.ts`. Document it in the **owning module's** `PART.md` §6. Grant only what it needs in `scripts/db/users.sql` (DA-9).
- **New recurring job:** add one entry to `createScheduledJobs` (`jobs/scheduled-jobs.ts:139-260`) with `name`, `intervalMs` and `run` returning a line or `null`. Check its schedule against DB state inside the pass. Both hosts pick it up, and `apps/server/scheduled-sweeps.test.mjs:549` and `scheduled-jobs.test.ts:34` must stay green. Never add a loop only to `main.ts`.
- **Changing the queue protocol:** `dispatcher.ts` + `outbox-store.ts` + `claim-attempts.test.ts` + `effects.test.ts` + `plat-004-relay.db.test.ts` change together.
- **Checks:** `pnpm --filter @tmanage/worker typecheck` and `test`, then the server tests, then `pnpm verify`. Memory "Single-suite runs do not typecheck": typecheck first.

## Tests and fitness checks

| File | Guards |
| --- | --- |
| `src/outbox/claim-attempts.test.ts` | W-1, W-2, W-3, unpark (`:473`), loop backoff and jitter (`:514`, `:522`), W-7 |
| `src/outbox/effects.test.ts` | W-4 |
| `src/outbox/backoff.test.ts` | W-8 |
| `src/outbox/health.test.ts`, `notice-drain.test.ts` | health evaluation, heartbeat, notice queue |
| `src/common/database/sweep-lock.test.ts` | W-9 |
| `src/jobs/scheduled-jobs.test.ts` | W-10 |
| `src/common/database/worker-database.test.ts` | W-11 |
| `src/common/database/upsert-affected-rows.guard.test.ts`, `outbox-backlog.test.ts` | store guards |
| `src/main.test.ts` | CLI modes |
| `apps/api/test/plat-004-relay.db.test.ts`, `rt-001-realtime.db.test.ts`, `usage-001-expiry-sweeper.db.test.ts`, `req-004-defer-sweep-message-files.db.test.ts` | W-6 and the real-DB protocol |
| `apps/server/scheduled-sweeps.test.mjs:549` | DC-7 fitness (W-10 across hosts) |

Missing (PR-1): a 1020 refund test; a `GET_LOCK` NULL → error test; a two-process realtime test.

## Open defects, decisions and risks

| Id | Class | Defect | Pri | Exit |
| --- | --- | --- | --- | --- |
| WRK-1 | DC-5 | `ER_CHECKREAD` 1020 is not recoverable in the batch classifier (`outbox-store.ts:515-522`). | P1 | shared write-conflict helper; test |
| WRK-2 | DC-1 | `GET_LOCK` NULL (error) is treated as "held" and the pass is skipped silently (`sweep-lock.ts:51`). | P1 | outcome `error`, logged |
| WRK-3 | DC-4 | No outbox producer `dedupe_key` (`0002:24-48`). | P1 | expand migration (AS-3) |
| WRK-4 | DC-3 | The realtime hub is per process. (Leader lease: built, W-13.) | P1 | ADR-0010 §6 |
| WRK-5 | none | ST-2: the pool wait queue is unbounded (`worker-database.ts:165-171`). | P2 | `queueLimit` |
| WRK-6 | none | No circuit breaker around SMTP or webhooks (ST-4). | P2 | breaker port in `packages/mail` and connectors |
| WRK-7 | none | Per-event backoff has no jitter (`backoff.ts:8-14`). | P2 | add jitter (bounded, injected `random`) |
| WRK-8 | none | DA-12 bend without an ADR (§5). | P2 | ADR |
| WRK-9 | none | Text logs, no spans; the correlation id is not logged (RT-7, OB-2, OB-4). | P2 | OBS-001 |
| WRK-10 | risk | Parked and published outbox rows are never purged (ST-6). | P2 | retention job |

## Glossary

- **Reserve / claim:** the two transactions of one batch. Reserve counts the attempt and commits; claim locks the rows and runs the handlers.
- **Parked:** a row at the attempt cap. It is still visible and reported, and it is never claimed until `--unpark`.
- **After-commit effect:** work a handler stages that runs only after the batch commits (sends, pushes).
- **Sweep lock:** `GET_LOCK('<schema>:sweep:<name>', 0)` on its own connection.
