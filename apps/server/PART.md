---
part: app/server
kind: app-runtime
context: platform-operations
owner: implementation-lead
lifecycle: production
depends_on: [api-common/database, app/worker, package/domain, web-shared/session]
provides_api:
  [
    '/healthz',
    '/csp-report',
    '/.well-known/security.txt',
    '/realtime (WebSocket upgrade)',
    '/v1/* (dispatch to API)',
    '/* (proxy to web child)',
  ]
consumes_api: ['/v1/platform/me (platform gate, in-process inject)']
tables_owned: []
rules:
  [
    RT-1,
    RT-2,
    RT-3,
    RT-4,
    RT-5,
    RT-6,
    RT-7,
    RT-9,
    RT-10,
    RT-11,
    ST-1,
    ST-3,
    ST-5,
    ST-6,
    ST-7,
    ST-8,
    HT-1,
    HT-2,
    AS-4,
    OB-2,
    OB-4,
    SE-2,
    PR-1,
    PR-5,
  ]
ux_rules: []
last_verified_commit: 954d80b32e5fbe6379a1c4e71bb45a616aa9ce65
last_verified_date: 2026-11-20
last_verified_by: Claude Opus 5.5 (lane G)
---

# app/server: the single Hostinger process

Scope (PART-DOCS §3.2): this doc covers the **runtime only**: boot order, public dispatch, the web child and its transport, readiness and health, shutdown, and how the in-process worker relay and the scheduled sweeps are hosted. What each sweep or job _does_ belongs to the owning module's `PART.md`.

## Purpose and bounded context

`apps/server/server.mjs` is the one Node process Hostinger shared hosting runs per domain (`server.mjs:1-3`; memory rule "One Hostinger app, no subdomain split"). It serves on the one public `PORT`:

| Path class | Handled by | Evidence |
| --- | --- | --- |
| `/v1/*` | NestJS/Fastify API, in-process via `fastify.routing(req, res)` (no second proxy hop) | `server.mjs:8-11`, `web-transport.mjs:428-431` |
| `/healthz` | answered here (dependency-light) | `web-transport.mjs:418-421` |
| `POST /csp-report` | `csp-report.mjs`, only once ready | `server.mjs:619-622` |
| `/.well-known/security.txt` | `security-txt.mjs`, any boot state | `server.mjs:619-622` |
| `/realtime` upgrade | worker's attached socket server | `server.mjs:627-630`, `realtime-inprocess.mjs:1-20` |
| platform paths | `platform-gate.mjs` asks the API first, then proxies | `server.mjs:596-612`, `platform-gate.mjs:70-75` |
| everything else | reverse proxy to a child `next start` over a private Unix socket | `server.mjs:15-17`, `web-transport.mjs:60-89` |

Context map: **downstream** of every API module (it hosts them) and of `app/worker` (it imports `@tmanage/worker` for the relay, sweeps and realtime, `server.mjs:335`, `:497-569`). **Upstream** of nothing in the domain sense; it is infrastructure (Clean Architecture outer ring, ENGINEERING-STANDARD §3). Users: Hostinger's launcher (liveness, restarts), browsers, the deploy smoke, uptime monitors.

## Domain model and invariants

There is no business domain. The runtime state machine is:

`listening (503 starting)` → `migrated` → `api created` → `web child started` → `[relay started]` → `[sweeps started]` → `ready` → `shutting down` → exit.

| # | Invariant (checkable) | Where | Proof |
| --- | --- | --- | --- |
| S-1 | The public port is bound **before** migrations, Nest or the web child (Hostinger restarts an app that has not listened in ~3 s, an unverified claim, see §11). | `server.mjs:631-638` precede `:690` | `web-transport.test.mjs:63` ("until ready, every path … answers 503 starting with Retry-After") |
| S-2 | Until `state.ready` is set, `/healthz` answers 503 at once and other requests wait ≤ `STARTUP_HOLD_MS` = 30 s (max 200 held), then get 503 with `Retry-After: 5`. | `web-transport.mjs:370-371`, `:380-416`, `:34`, `:207-214` | `web-transport.test.mjs:515`, `:541` |
| S-3 | A held request's body is not read while it waits, so an upload part reaches the API intact. | `web-transport.mjs:366-368` | `web-transport.test.mjs:515` |
| S-4 | `NODE_ENV` is fixed to production before any other module is evaluated. | `server.mjs:35-37` (`import './production-env.mjs'` first) | `boot-guards.test.mjs` |
| S-5 | API path variants that differ only in case or escaping are refused (404). Absolute-form targets get 400 and are never proxied. | `web-transport.mjs:227-246` | `web-transport.test.mjs:346`, `:380` |
| S-6 | Every job loop of the standalone worker either runs in this app or is listed as standalone-only, with a reason (DC-7). | `scheduled-sweeps.mjs:540-563` (`WORKER_LOOPS_IN_APP`, `STANDALONE_ONLY_LOOPS`) | `scheduled-sweeps.test.mjs:549` parses `apps/worker/src/main.ts` |
| S-7 | Each sweep and scheduled job runs under its own MariaDB named lock, so two processes never run the same pass at once. | `scheduled-sweeps.mjs:30-33`, `:580-585`; `apps/worker/src/common/database/sweep-lock.ts:45-62` | `scheduled-sweeps.test.mjs:164`, `:573` |
| S-8 | A tick that fires while the previous one is still running is skipped, not stacked. | `scheduled-sweeps.mjs:596-604` | `scheduled-sweeps.test.mjs:236`, `:337` |
| S-9 | A platform path is never answered "sign-in" on a 5xx, 429 or 408 from the API: the outcome is `unknown` and goes to the web (DC-1). | `platform-gate.mjs:70-75` | `platform-gate.test.mjs:122` |

## Public API and contracts

| Method + path | Status codes | Notes |
| --- | --- | --- |
| `GET /healthz` | 200 `{"status":"ok"}` when ready; 503 `{"status":"starting"}` + `Retry-After: 5` before | `web-transport.mjs:418-421`, `:207-214`. It **is readiness**, not liveness (RT-5 gap) |
| `POST /csp-report` | rate-limited, size-capped, one redacted log line | `csp-report.mjs` (56-01) |
| `GET /.well-known/security.txt` | RFC 9116 | `security-txt.mjs` (56-17) |
| `GET /downloads/*` | the desktop installer as octet-stream; 503 when it is missing | `web-transport.mjs:322`, test `:489` |
| `Upgrade /realtime` | handed to the attached socket only when ready; anything else is closed | `realtime-inprocess.mjs:67-86`, test `web-transport.test.mjs:409` |
| `/v1/*` | whatever the API answers | `web-transport.mjs:428-431`, `applyApiCacheDefault` |

Environment contract (RT-1): validated by `loadEnv()` from `@tmanage/config` (`server.mjs:689`). Hostinger DB variables are resolved first (`database-env.mjs`, `server.mjs:676-683`); only notes are logged, never values. Runtime switches: `WORKER_INPROCESS=1` (live, `deploy/hostinger/.env.example:160`), `SWEEPS_INPROCESS` (on by default, `scheduled-sweeps.mjs:47-52`), `SWEEPS_INTERVAL_MS` (≥ 10 s), `RECONCILE_INTERVAL_MS` (≥ 1 min), `REALTIME_INPROCESS`, `TMANAGE_WEB_TRANSPORT`, `TMANAGE_WEB_SOCKET`, `FIGMA_SNAPSHOT_INPROCESS` (defaults to 1, `server.mjs:685-687`).

Exports used by tests and the bundle: `createPublicHandler`, `resolveWebTransport`, `prepareWebTransport`, `createSweepScheduler`, `lockedPass`, `startScheduledJobs`, `platformDecision`, `createMigrationGate`.

## Data: tables and migrations

The part owns **no tables** and writes no SQL itself (AR-4). It runs the migrator at boot (`runMigrations`, `server.mjs:140-160`, under the migration gate) and hands the API pool to Nest. Files it writes:

| File | Purpose | Growth control (ST-6) |
| --- | --- | --- |
| `.run/web-<pid>.sock` (0600, dir 0700) | this instance's web child socket | own path unlinked on start and exit; sockets of dead pids cleared at prepare (`prepareWebTransport`) |
| `OUTBOX_HEARTBEAT_FILE` | the relay's last clean pass; read by `/healthz/deep` | overwritten (`job-alerts.mjs:56-60`) |
| `.crash-alert.json` | crash-mail throttle across restarts | overwritten (`server.mjs:704-709`) |

## Permissions and tenant rules

- **Trust boundary:** this process is the TLS-terminated origin behind Hostinger's proxy. Client IPs are read only through `TRUSTED_PROXY_ADDRESSES` (`server.mjs:592`, `:613-615`). This is the appending-proxy rule; see memory "An appending proxy is the safe form".
- **Platform admin:** whether a viewer may see the Platform shell is decided by the API (`GET /v1/platform/me`, injected in-process), never by the web (`platform-gate.mjs:66-75`; AR-8). 200 or 403 opens the page, 401 with the readable CSRF cookie opens it (refreshable), 401 without the cookie goes to sign-in, 5xx/429/408 is `unknown`, and any other answer is 404.
- **Page limiter:** a per-address limit applies to the server-rendered sign-in, sign-up and setup pages (`page-limit.mjs`, `server.mjs:592`, `:606`). This is ST-8 for those pages; API routes keep the API's own throttle.
- **Tenant scope:** none here. The API owns every tenant decision (DA-12).

## Runtime, background work and failure modes

**Boot** (`server.mjs:564-730`): resolve transport → listen → install signal handlers → resolve DB env → `loadEnv` → migrations → `createApi` → crash alerts → `startWeb` → `state.ready` → in-process relay (if `WORKER_INPROCESS=1`) → sweeps, through `becomeReady` (`web-transport.mjs`; RT-4, `954d80b3`).

**Pools (ST-5 bulkheads):** the API pool belongs to Nest. The relay has its own pool of ≤ 2 connections (`server.mjs:382-387`). The minute sweeps have their own 1-connection pool (`:504-509`), the jobs another (`:542-547`), and the sweep locks a third (`:511`; `sweep-lock.ts:72-80`). A nightly rebuild therefore cannot hold the minute sweeps' connection.

**Hosted background work (owned elsewhere):** the outbox relay and notice queue tick every `OUTBOX_POLL_INTERVAL_MS` behind an in-process `running` guard (`server.mjs:451-472`); cross-process safety comes from `FOR UPDATE SKIP LOCKED` (`apps/worker/src/common/database/outbox-store.ts:109`, `:194`). The sweeps and the scheduled jobs come from the one shared list `apps/worker/src/jobs/scheduled-jobs.ts` (`startScheduledJobs`, `scheduled-sweeps.mjs:507-536`).

**Failure modes:**

| Failure | Behaviour today | Pattern / rule | Gap |
| --- | --- | --- | --- |
| Request during boot | held ≤ 30 s, then 503 + Retry-After | ST-5 (bounded queue), HT-1 | fixed `954d80b3`: ready after API + web child; relay and sweeps start after (RT-4) |
| Second process (restart overlap, on-demand spawn) | per-process socket `.run/web-<pid>.sock`: neither instance unlinks the other's (`954d80b3`) | RT-2 | socket part fixed; leader lease still open (SRV-3) |
| Singleton duties on 2 instances | sweeps/jobs: named lock per pass (ok). Relay: SKIP LOCKED (ok). Realtime hub: per process, so pushes are lost across instances (`realtime-inprocess.mjs:92-112`). No leader lease. | RT-3 | **DC-3 P1 open** |
| In-memory throttles | `purgeJob` and `storageRootJob` keep `last` in memory (`scheduled-sweeps.mjs:647-675`); each instance runs them hourly (the lock only prevents running _at the same time_) | AS-4 | **open P1** |
| Lock query error | `GET_LOCK` NULL looks the same as "held" (`sweep-lock.ts:51`), so the pass is skipped silently; a thrown error is logged by the scheduler (`scheduled-sweeps.mjs:588-590`) | AS-4 ("held" ≠ "failed") | **open P1** |
| SIGTERM | `server.close()` (`:656`), kill the child, wait for the migration gate (≤ 120 s, `migration-shutdown.mjs:20`), stop sweeps, worker and Nest, then `process.exit(0)` (`:670`) | RT-6 | no drain budget, no `closeIdleConnections()`, no lease release; keep-alive sockets can hold `close` |
| Slow or idle client | proxy upstream destroyed after 120 s idle (`web-transport.mjs:284-311`) | ST-1 (partial) | **ST-3**: no `requestTimeout`, `headersTimeout` or `keepAliveTimeout` on `createHttpServer` (`server.mjs:619`). Grep found none. |
| Web child crash | supervised restart with backoff (`web-restart.mjs`, `server.mjs:261-280`) | Fail fast + supervisor | ok |
| Uncaught exception | mail to `ALERT_EMAILS` at most once per 15 min, then exit 1 (`process-alerts.mjs`, `server.mjs:696-709`) | Fail fast | ok |
| Migration failure | `MigrationError` → exit 1 (`server.mjs:732-737`) | ST-7 | the schema-drift refusal lives in api-common/database |
| Relay wedged | heartbeat watchdog mails once per stale spell (`server.mjs:475-482`); `/healthz/deep` reports `worker: fail` | RT-11 (partial) | deep health is pass/fail, not `healthy/degraded/unhealthy` |

**Logging (RT-7):** `log()` writes `[server] <text>` to stderr (`server.mjs:126-128`). This is plain text, not JSON, with no instance id, so a second process cannot be seen in the log (DC-3 diagnosis gap).

## UX rules for its screens

n/a — the part renders no screen. Its only user-visible output is the 503 `starting` JSON. What a browser shows during that window is owned by `web-shared/session` (the "can't reach, retrying" state, SE-2).

## Standards that apply

| Rule | Today | Target |
| --- | --- | --- |
| RT-1 | Env validated by `loadEnv` (zod, `@tmanage/config`); secrets only reach the log as notes (`server.mjs:678-683`) | met |
| RT-2 | Socket per process (`web-<pid>.sock`, `954d80b3`); throttles, realtime hub and heartbeat still per process | DB-held throttles, realtime via DB/outbox (SRV-3, SRV-4) |
| RT-3 | Named lock per pass; no leader lease; realtime per process | `GET_LOCK('tmanage:leader')` on a dedicated connection for relay, sweeps and realtime source |
| RT-4 | met (`becomeReady`, `954d80b3`) | keep |
| RT-5 | Only `/healthz` (= ready) and the API's `/healthz/deep` | add `/livez` (200 once listening) |
| RT-6 | close, then exit, with no drain budget | drain ≤ 10 s (proposed), `closeIdleConnections()`, release lease |
| RT-7 | text lines on stderr | one JSON event per line with instance id and correlation id |
| RT-9 | deploy gates in `deploy/hostinger` | owned by ops part |
| RT-10 | "wait 3 min, then one request" ritual still in use (memory "Restart Hostinger quietly") | retire once RT-2, RT-3 and RT-4 are green |
| RT-11 | binary deep health | health model with required/fallback classes |
| ST-1 | proxy idle timeout 120 s; in-process inject needs none | met for the proxy |
| ST-3 | not set | set all three, below the proxy's limits |
| ST-5 | separate pools for relay, sweeps, jobs and lock; bounded startup hold | met |
| ST-6 | socket, heartbeat and crash files are overwritten, not appended | met |
| ST-7 | refuses non-production `NODE_ENV`; a migration error exits 1 | met here |
| ST-8 | page limiter on the auth pages before the web child | met for pages |
| HT-1 | 503 + Retry-After while starting | met |
| HT-2 | `platformDecision` is a second classifier beside `apps/web/src/lib/session-check.ts` | one shared classifier (`packages/contracts`, ADR-0009 proposed) |
| AS-4 | DB lock per pass; hourly throttles in memory | throttle state in the DB (`job_runs`); NULL ≠ held |
| OB-2/OB-4 | no spans; correlation id not on server log lines | OTel spans per request and job run |
| PR-1 | DC-7 fitness test present (`scheduled-sweeps.test.mjs:549`) | add a two-instance test (DC-3) |
| PR-5 | no readiness review on record | DESIGN-CHECKLIST §J before a new job is hosted here |

## How to change this part

- **New recurring job:** do not add a loop here. Add it to `apps/worker/src/jobs/scheduled-jobs.ts` (one list, both hosts), document it in the owning module's `PART.md` §6, and run `node --test apps/server/scheduled-sweeps.test.mjs` (S-6 fails if a worker loop is missing here).
- **New public non-`/v1` path:** add it to the dispatch in `server.mjs:619-622` or `createPublicHandler` (`web-transport.mjs:374`). Decide whether it may answer before ready (only dependency-free handlers may). Add a `web-transport.test.mjs` case. Add a STRIDE row (SE-6).
- **Changing boot order:** keep S-1 (listen first). Any change to readiness must keep `web-transport.test.mjs:63` and `:515` green, and should move toward RT-4.
- **Files that change together:** `server.mjs` ↔ `scheduled-sweeps.mjs` ↔ `apps/worker/src/index.ts` exports ↔ the bundle copier `deploy/hostinger/*` (`scheduled-sweeps.test.mjs:264` checks the copy).
- **Checks:** `pnpm --filter @tmanage/server test` (runs the 16 `*.test.mjs` files listed in `apps/server/package.json`), then `pnpm verify`.

## Tests and fitness checks

| File | Guards |
| --- | --- |
| `web-transport.test.mjs` | S-1, S-2, S-3, S-5, transport selection, socket 0600, hop-by-hop headers, upstream teardown |
| `scheduled-sweeps.test.mjs` | S-6 (DC-7 fitness, `:549`), S-7, S-8, cadences, lock per job (`:573`), bundle copy (`:264`) |
| `platform-gate.test.mjs` | S-9, AUTHSTATE refreshable 401 (`:87`), 5xx keeps the session (`:122`) |
| `migration-shutdown.test.mjs` | the bounded wait while a migration file runs |
| `boot-guards.test.mjs` | S-4, security headers |
| `web-restart.test.mjs`, `web-child-host.test.mjs` | child supervision |
| `process-alerts.test.mjs`, `job-alerts.test.mjs` | crash and job alert throttles, heartbeat |
| `database-env.test.mjs`, `page-limit.test.mjs`, `csp-report.test.mjs`, `security-txt.test.mjs`, `cache-headers.test.mjs`, `realtime-inprocess.test.mjs`, `brand-icons.test.mjs` | their modules |

Added in `954d80b3` (`web-transport.test.mjs`): two-instance socket ownership (DC-3) and ready-before-slow-worker (RT-4). Missing (PR-1): a live two-process serve test (stop A, B serves, no 502); a SIGTERM test with a keep-alive client for RT-6/ST-3; a test that `GET_LOCK` NULL is reported as an error.

## Open defects, decisions and risks

| Id | Class | Defect | Pri | Exit |
| --- | --- | --- | --- | --- |
| SRV-1 | DC-3 | **Fixed `954d80b3`:** socket `.run/web-<pid>.sock`; prepare clears only its own path and dead pids' sockets; cleanup only its own. Test: `web-transport.test.mjs` "two overlapping instances". | closed | — |
| SRV-2 | DC-3/DC-1 | **Fixed `954d80b3`:** `becomeReady` marks ready after API + web, then starts relay and sweeps. Test: `web-transport.test.mjs` "RT-4". | closed | — |
| SRV-3 | DC-3 | No leader lease. The realtime hub is per process. | P1 | ADR-0010 (staged in `D:/TManage/work/pass-2026-11-20/adr-staged`) |
| SRV-4 | DC-3 | The hourly throttles for purge and storage root are in memory (`scheduled-sweeps.mjs:647-675`). | P1 | throttle row in DB |
| SRV-5 | DC-1 | A `GET_LOCK` NULL (error) is treated as "held" (`sweep-lock.ts:51`). | P1 | three outcomes `ran / held / error` |
| SRV-6 | DC-3 | Shutdown has no drain budget and no server timeouts (`server.mjs:648-672`, `:619`). | P1 | RT-6 / ST-3 |
| SRV-7 | DC-2 | `platformDecision` duplicates the web session classifier (`platform-gate.mjs:70-75` vs `apps/web/src/lib/session-check.ts`). | P1 | ADR-0009 shared `http-outcome` |
| SRV-8 | none | Logs are text with no instance id (`server.mjs:126-128`). | P1 | RT-7 |
| SRV-9 | risk | The "LiteSpeed restarts within ~3 s" claim (`server.mjs:19-21`) is unverified; Hostinger documents only on-demand start (ARCH-REVIEW DC-3). | P2 | host log evidence |

## Glossary

- **Web child:** the private `next start` process the server spawns and proxies to.
- **Startup hold:** the bounded wait (30 s, max 200) before a request gets 503 `starting`.
- **Sweep lock:** a MariaDB named lock per pass, `<schema>:sweep:<name>`, cut to 64 characters.
- **In-process worker:** the outbox relay, the notice queue and realtime running inside this process (`WORKER_INPROCESS=1`).
