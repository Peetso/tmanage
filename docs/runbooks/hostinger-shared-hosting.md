# Deploying TManage on Hostinger shared hosting

The concrete plan for the recorded target: **Hostinger shared hosting**, a subfolder of an
existing site (`/home/u152275336/domains/peetrix.com/public_html/tmanage`), with Node.js
available through hPanel as **one proxied application per domain**
(`docs/implementation-status.md`, "The deployment target, recorded 2026-08-26").

This is not the shape `docs/planning/50-BOOTSTRAP-DEPLOYMENT-ON-ONE-PAID-PLAN.md` §3 assumes.
That section assumes Hostinger **Cloud** and three long-running Node applications. The planning
pack is immutable and was not edited; this runbook records how the same code deploys against a
host that supervises one application per domain, and states plainly what that host cannot do.

Scope. This file is the first-deploy plan for the shared-hosting target: process layout, the
full environment checklist, and the decisions the plan forces. It does **not** restate the D07
(TOTP seeds) or D09 (trusted proxy) change procedures — those live in `docs/runbooks/deploy.md`
and are referenced where they bear on this plan. Prerequisites (`pnpm db:migrate`,
`scripts/db/users.sql`) come from `deploy.md` and `scripts/db/users.sql` respectively.

Every environment claim below is verified against `packages/config/src/env.ts` and the process
entry points `apps/api/src/main.ts`, `apps/worker/src/main.ts`, `apps/api/src/verify.ts`,
`apps/api/src/sweep.ts`, `apps/api/src/reconcile.ts`, and `apps/web/next.config.ts`, at the commit
this file was written on.
File and line are cited so a reader can re-check each one.

---

## 1. Before you commit to the plan — three things to confirm in hPanel

If any of these three is absent, **stop**: the plan is wrong for this account, not the code.

1. **At least two Node application slots on two hostnames.** The web app and the API are two
   different Node frameworks (Next.js and NestJS/Fastify) and there is no path that runs one
   inside the other — see §2. Two slots is the floor. One slot in total means TManage cannot be
   deployed at all.
2. **A cron manager**, or an external way to run a shell command on a schedule (§4). Without a
   scheduler the outbox never drains, uploaded files never leave quarantine, and usage counters
   are never reconciled — four of the six processes have no driver.
3. **A Node 22.x runtime.** The repository's `engines` requires `node >=22.12.0 <23`
   (`package.json`). Confirm hPanel offers 22.x before anything else.

---

## 2. The six processes, and how they fold onto this host

The code is six processes (plus one conditional listener). Three are long-running or scheduled;
three are scheduled one-shot passes. Here is where each one lands.

| #   | Process                             | Entry command                                                                                                                    | Where it goes on this host                                                                                                                                              |
| --- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Web**                             | `next start --port 3000` (`apps/web/package.json` `start`)                                                                       | **App slot 1**, on the primary hostname (e.g. `peetrix.com`). Also the same-origin proxy: it rewrites `/v1/*` to the API (§3).                                          |
| 2   | **API**                             | `node dist/main.js` — **there is no `start` script in `apps/api/package.json`**; the hPanel entry command is written out by hand | **App slot 2**, on a second hostname (e.g. `api.peetrix.com`).                                                                                                          |
| 3   | **Worker / outbox relay**           | `node dist/main.js --once` (`apps/worker/package.json` `relay:once`)                                                             | **Cron**, not an app slot (§4). The `--once` mode runs one controlled batch and exits — `apps/worker/src/main.ts:104-117`.                                              |
| 4   | **Verify + scan pass**              | `node dist/verify.js --once` (`apps/api/package.json` `verify:once`)                                                             | **Cron** (§4). One verification pass then one scan pass, then exit — `apps/api/src/verify.ts:35-53`.                                                                    |
| 5   | **Sweep pass**                      | `node dist/sweep.js --once` (`apps/api/package.json` `sweep:once`)                                                               | **In-process, no cron** (§4). The one Node app (`apps/server`) runs this pass every minute after the worker sweeps — `apps/server/scheduled-sweeps.mjs` `apiSweepJobs`. |
| 6   | **Reconcile pass**                  | `node dist/reconcile.js --once` (`apps/api/package.json` `reconcile:once`)                                                       | **In-process, no cron** (§4), on its own hourly scheduler in the one Node app — `apps/server/scheduled-sweeps.mjs` `apiReconcileJobs`.                                  |
| 7   | **Realtime socket** _(conditional)_ | inside process 3, loop mode only, when `REALTIME_PORT > 0`                                                                       | **Off.** Set `REALTIME_PORT=0` (the default). See below.                                                                                                                |

### The API cannot fold into the web app

The API is NestJS on Fastify; the web app is Next.js. Neither runs inside the other, and the
codebase does not pretend otherwise. `apps/web/src/lib/public-config.ts` only changes what the
**browser** sees; the two Node applications stay two Node applications. **Two app slots on two
hostnames is the hard floor.** The topology that makes cookies work across them is in §3.

### Processes 3, 4, 5 and 6 are already cron-shaped

None of these four has an in-process scheduler; that is deliberate. `apps/worker/src/main.ts`
runs one batch and exits under `--once` (lines 104-117); `verify.ts`, `sweep.ts` and
`reconcile.ts` accept `--once` "for symmetry and is the only behaviour" (`verify.ts:20`,
`sweep.ts:16-17`, `reconcile.ts:16-17`). The delivery tick is three passes, in this order:
**`relay:once`, `sweep:once`, `verify:once`** — `sweep.ts:13-16`, `verify.ts:30-33`. The
reconcile pass (`reconcile:once`) runs the same `--once` shape but on its own **hourly**
schedule rather than in the every-minute chain: it is a data-integrity sweep over every
organization's counter, has no delivery-latency requirement, and running a full-table scan every
minute would waste work and contend needlessly with live counter writes. §4 covers how to run
them.

On the single Hostinger app, passes 5 and 6 no longer need cron: `apps/server` runs them on
in-process timers with the same cadences (§4.0).

### The realtime socket cannot be provided, and nothing is lost that matters

A shared plan proxies one HTTP application per domain; a second listener on an arbitrary port is
not reachable from the internet, and the socket only exists in the worker's **loop** mode
(`apps/worker/src/main.ts:128-136`), which this host does not run. With `REALTIME_PORT=0`
(env.ts:286 default) the socket never starts, the API answers `socketUrl: null`, and the chat
hook settles without connecting. Chat still works; it just does not update live. Leave
`REALTIME_PUBLIC_URL` unset (env.ts:293-300).

---

## 3. The two-hostname, same-origin topology (non-negotiable)

Cookies are host-only. If the browser talked straight to `api.peetrix.com`, the API's readable
CSRF cookie would be invisible to the page's script and its path-scoped refresh cookie would
never be sent — this is review finding D03, documented in `apps/web/src/lib/public-config.ts`.
The supported shape is **same-origin through the web app**: the browser talks only to the web
origin, and Next.js rewrites `/v1/*` to the API.

Set, on the **web** app slot's build/runtime environment:

```
NEXT_PUBLIC_API_BASE_URL=same-origin
API_PROXY_TARGET=https://api.peetrix.com     # the API's origin as the web server reaches it
```

Set, on the **API** app slot:

```
API_PUBLIC_URL=https://peetrix.com           # the WEB origin — it decides the cookies' Secure flag
WEB_PUBLIC_URL=https://peetrix.com
CORS_ALLOWED_ORIGINS=https://peetrix.com
```

`API_PUBLIC_URL` is the **web** origin, not the API's, in this topology (env.ts:135; the Secure
flag follows it). `NEXT_PUBLIC_API_BASE_URL` and `API_PROXY_TARGET` are validated at **build
time** by `apps/web/next.config.ts:36-41` (D19): a production build with `NEXT_PUBLIC_API_BASE_URL`
absent, plain-http, or loopback fails inside `next build`, and `API_PROXY_TARGET` is required
exactly when the base URL is `same-origin`. Do **not** set `NEXT_PUBLIC_API_BASE_URL` to the
sibling subdomain.

Behind hPanel's reverse proxy, also set `TRUSTED_PROXY_ADDRESSES` on the API so `request.ip` is
authentic — otherwise both address-keyed sign-in budgets are evadable. This is D09; the value,
the measured trade-offs, and the appending-vs-prepending proxy hazard are in
`docs/runbooks/deploy.md` (D09 section). In this worktree the API already honours it:
`apps/api/src/main.ts:43` passes `trustProxy: env.TRUSTED_PROXY_ADDRESSES` (env.ts:148-161), and
unset means trust nobody. Set it to the proxy's address/range; do not leave it at the default
once the API faces the internet through hPanel.

---

## 4. Running the passes — with cron, and without

Cron does **not** inherit an hPanel application's environment variables: the entries run in a
plain shell, not inside the app. Each cron command therefore needs the **full production
environment** loaded itself. The processes call `loadEnv()` first thing
(`apps/worker/src/main.ts:73`, `apps/api/src/verify.ts:36`, `apps/api/src/sweep.ts:31`) and
`loadEnv` throws `EnvironmentValidationError` (env.ts:546-554, 562-566) before doing any work if
a single variable is missing — so an under-provisioned cron entry fails loudly, it does not run
half a batch.

### 4.0 The single Hostinger app needs no cron for the sweep and reconcile passes

The one Node app (`apps/server/server.mjs`, the bundle `deploy/hostinger/build.mjs` builds) runs
the sweep pass (process 5) and the reconcile pass (process 6) itself, from the in-process API
application, with the same providers, pool and credential `sweep.ts` and `reconcile.ts` compose:

| Pass                       | In-process job      | Cadence                                         |
| -------------------------- | ------------------- | ----------------------------------------------- |
| `sweep:once` (process 5)   | `upload-sessions`   | every minute, after the worker's `--sweep-*`    |
| `reconcile:once` (proc. 6) | `storage-reconcile` | hourly, on its own scheduler (and once at boot) |

The rules are those of the worker sweeps (`apps/server/scheduled-sweeps.mjs`): a pass still
running when its next tick fires is skipped, not stacked; a quiet pass logs nothing, a pass that
moved rows or failed logs one `[server] sweep <job>: …` line with the standalone pass's report;
one job's failure does not stop the next. `SWEEPS_INPROCESS=0` turns all of it off (only then
are the §4a entries for these two passes needed). `SWEEPS_INTERVAL_MS` tunes the minute cadence
(at least 10 s); `RECONCILE_INTERVAL_MS` tunes the hourly one (at least 60000, default 3600000).
Two instances cannot double-apply either pass: the sweeper releases a row only through a
state-conditioned transition (a racing pass counts it `skipped`), and the reconciler corrects
each counter under that counter's own row lock. The reconcile pass also runs once at every boot,
so an app that the host idles and restarts more often than hourly still reconciles.

The §4a entries below stay the reference for a deploy that runs the passes as separate
processes; on the single app, register only what is not already in-process.

### 4a. With a cron manager (separate processes only)

Register **one** entry that sources an env file and runs the three delivery passes in order:

```sh
# every minute; adjust to the plan's smallest granularity
set -a; . /home/u152275336/tmanage.env; set +a
cd /home/u152275336/domains/peetrix.com/public_html/tmanage
node apps/worker/dist/main.js --once && \
node apps/api/dist/sweep.js --once && \
node apps/api/dist/verify.js --once
```

Order matters: relay first (drains the outbox), then sweep (releases expired reservations), then
verify+scan (`sweep.ts:13-16`, `verify.ts:30-33`). Delivery latency becomes the cron granularity
— typically one minute at best on a shared plan, so a client-request email can be up to a minute
late. That is acceptable and is what the code was built for.

Register a **second, hourly** entry for the reconcile pass — it is not part of the delivery tick
above:

```sh
# hourly; a data-integrity sweep, not a delivery pass
set -a; . /home/u152275336/tmanage.env; set +a
cd /home/u152275336/domains/peetrix.com/public_html/tmanage
node apps/api/dist/reconcile.js --once
```

`reconcile:once` (`apps/api/src/reconcile.ts`) walks every organization's usage counter, sums its
append-only ledger under the counter's own lock, corrects any drift towards the ledger and stamps
`reconciled_at`. It is what writes `reconciled_at` in production at all — without this entry the
column is only ever set by a hand-run of `reconcile:once`. It runs **hourly, not every minute**:
it has no delivery-latency requirement, it is a full-table scan whose cost scales with the number
of organizations, and running it in the minute chain would contend with live counter writes for
no benefit. Hourly is the intended order; loosen or tighten it to how fresh `reconciled_at` needs
to be for monitoring, never below the minute chain's cadence.

The env file (`tmanage.env` above) must carry the whole §5 checklist, including
`AUTH_MFA_SEED_KEYS`, `SESSION_SECRET`, `CSRF_SECRET` and the three database URLs, in plaintext
next to the code. **This is the shortfall `deploy.md` warns against** ("not a file on the
application server"). On this host there is no per-application secret store the cron shell can
read, so the plaintext env file is the only option. Record it as a known shortfall; do not let it
pass unremarked. Give the file the tightest permissions the account allows (`chmod 600`) and keep
it outside `public_html` (the path above is; a file under `public_html` could be served).

### 4b. Without a cron manager

If hPanel has no cron manager on this plan, there is **no in-code fallback that is both safe and
sufficient**, and this becomes a decision (§6):

- **External scheduler over SSH.** A scheduler you control elsewhere (another host, an uptime
  service that can run SSH) invokes the exact command block from §4a. This works and keeps the
  `--once` shape. It needs SSH access to the account and moves the plaintext env-file problem
  onto that connection.
- **In-API startup timer** — do **not** use. The relay would then run under `DATABASE_URL` (the
  API's credential), but production requires `WORKER_DATABASE_URL` to name a _different_,
  least-privilege user (env.ts:475-488). Folding the relay into the API does not fail validation
  — the variable is simply ignored — so the guarantee is lost with no error. A shared-host app is
  also idled and restarted on traffic, so the timer is not reliable anyway.
- **Request-path trigger** — not available: no such endpoint exists in the code, and an
  unauthenticated one would be a denial-of-service lever.

If none of §4a or the SSH option is possible, the outbox never drains: in-app notifications and
client-request emails are never sent, and the backlog is silent. That is a hard blocker, not a
degradation — see §6.

---

## 5. Environment checklist

From `packages/config/src/env.ts`. `loadEnv` validates the whole bag at boot and names every bad
variable at once (env.ts:562-566). Set these on **both** app slots' environments **and** in the
cron env file (§4) — every process runs the same `loadEnv`.

### 5a. No default — every environment refuses to boot without these (10)

| Variable                 | Source (env.ts)                                                                    | Value for this deploy                                                     |
| ------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `API_PUBLIC_URL`         | `:135` `z.string().url()`; prod https `:530-532`                                   | `https://peetrix.com` (the **web** origin — §3)                           |
| `WEB_PUBLIC_URL`         | `:136`; prod https `:533-535`                                                      | `https://peetrix.com`                                                     |
| `CORS_ALLOWED_ORIGINS`   | `:137`, `originList :88-106`; prod https `:536-540`                                | `https://peetrix.com`                                                     |
| `DATABASE_URL`           | `:164` `mysqlUrl`; runtime user                                                    | hPanel MySQL user 1 (runtime)                                             |
| `DATABASE_MIGRATION_URL` | `:165`; must differ, and in prod be a different **user** `:455-460, :469-474`      | hPanel MySQL user 2 (schema owner)                                        |
| `STORAGE_BUCKET`         | `:196` `nonEmpty`                                                                  | R2/S3 bucket name — required even though the driver is unavailable (§6)   |
| `SESSION_SECRET`         | `:222` `secret` ≥32; prod placeholder/dup checks `:505-528`                        | generated ≥32-char secret                                                 |
| `CSRF_SECRET`            | `:225` ≥32; same checks                                                            | generated, distinct from `SESSION_SECRET`                                 |
| `AUTH_MFA_SEED_KEYS`     | `:249` `superRefine` (no default); `<version>:<base64url 32 bytes>`, `;`-separated | the seed keyring (D07 — see `deploy.md`); same value in **every** process |
| `EMAIL_FROM_ADDRESS`     | `:356` `z.string().email()`                                                        | the sending mailbox address                                               |

### 5b. Defaults that `NODE_ENV=production` rejects — must also be set (7)

The production guardrails run only when `NODE_ENV=production` (env.ts:462 short-circuits
otherwise), so `NODE_ENV` itself is the switch that makes the rest of this table apply.

| Variable                    | Source (env.ts)                                                                          | Value for this deploy                    |
| --------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------- |
| `NODE_ENV`                  | `:118` default `development`; guardrails gated at `:462`                                 | `production`                             |
| `WORKER_DATABASE_URL`       | `:174` optional; required in prod, distinct third user `:475-488`                        | hPanel MySQL user 3 (relay)              |
| `STORAGE_ACCESS_KEY_ID`     | `:197` optional; required for `s3` `:417-419`; `s3` is the only prod-legal driver `:492` | R2/S3 access key                         |
| `STORAGE_SECRET_ACCESS_KEY` | `:198`; required for `s3` `:420-421`                                                     | R2/S3 secret key                         |
| `EMAIL_DRIVER`              | `:355` default `console`; `console` refused in prod `:494`                               | `smtp`                                   |
| `SMTP_HOST`                 | `:362` optional; required when `EMAIL_DRIVER=smtp` `:439-441`                            | `smtp.hostinger.com`                     |
| `MALWARE_SCAN_DRIVER`       | `:385` default `stub`; `stub` refused in prod `:493`                                     | `none` (no clamd on shared hosting — §6) |

**A production boot refuses to start without all 17 of the above.** In practice add two more —
the SMTP credentials are a pair (env.ts:445-450) and Hostinger's submission endpoint needs them:

| Variable        | Source (env.ts)               | Value                |
| --------------- | ----------------------------- | -------------------- |
| `SMTP_USERNAME` | `:364`; pair check `:445-450` | the mailbox login    |
| `SMTP_PASSWORD` | `:365`; pair check `:448-450` | the mailbox password |

So **19 in practice**.

### 5c. Web build-time (outside env.ts, validated by next.config.ts)

| Variable                   | Source                                                       | Value                     |
| -------------------------- | ------------------------------------------------------------ | ------------------------- |
| `NEXT_PUBLIC_API_BASE_URL` | `next.config.ts:36-41` → `public-config.ts`; D19             | `same-origin`             |
| `API_PROXY_TARGET`         | `next.config.ts:40`; required when base URL is `same-origin` | `https://api.peetrix.com` |

### 5d. Set deliberately even though they have defaults

- `REALTIME_PORT=0` and no `REALTIME_PUBLIC_URL` — env.ts:286, 293-300 (§2).
- `STORAGE_REGION=auto` and `STORAGE_ENDPOINT=<R2 account endpoint>` for Cloudflare R2 — env.ts:195
  defaults to `us-east-1`, env.ts:194 for the endpoint. (Moot until the driver exists — §6.)
- `SMTP_SECURE` — env.ts:374-377. Leave `false` for port 587 STARTTLS; set `true` only with
  `SMTP_PORT=465`.
- `DATABASE_POOL_MAX` — env.ts:178, default 5 **per process**. Two app slots plus each cron tick
  each open a pool against the shared MariaDB connection allowance; the worker caps itself at 2
  (`apps/worker/src/main.ts:83`). Count them against the plan's connection limit before deploying
  and lower this if needed.
- `RATE_LIMIT_AUTH_MAX_PER_SOURCE` — env.ts:346, default 30 (~15 complete MFA sign-ins per
  address per 5 minutes). Behind office NAT that is per-office; raise it deliberately, not after a
  complaint.
- `ALERT_EMAILS` (env.ts:490) — the owner's address(es), comma-separated, for error and job
  alert mails; set `OUTBOX_HEARTBEAT_FILE` too. Steps, the uptime monitor on `/healthz/deep` and
  the service targets are in `docs/runbooks/slo-and-alerts.md`.
- `TENANT_GUARD_MODE=enforce`, `DEPLOYMENT_PROFILE=bootstrap` — env.ts:185, 131; both already the
  defaults, do not touch.

### 5e. Variables the schema demands that nothing reads

`REDIS_URL`, `QUEUE_DRIVER`, `CACHE_DRIVER` (env.ts:188-190) are validated at boot but no code
outside `env.ts` and the e2e stack reads them. Their defaults satisfy production's substitute
check, so **no action is needed** — but do not provision Redis for them; the system does not use
it.

### 5f. First-owner setup (fresh install)

There is no public sign-up, so a fresh install has no way in until the first owner exists. Set
`SETUP_TOKEN` (a one-time secret of at least 32 characters, from `node generate-secret.mjs`) on
the **API** app slot only — the cron env file (§4) does not need it — then restart that slot.
With it set the API registers `GET /public/setup` and `POST /public/setup`, and the web app's
`/setup` page offers the form; without it the routes are not registered at all (an ordinary 404)
and `/setup` says setup is not available. The web slot does not read the variable.

The route needs no new table or migration and works on Hostinger's MariaDB 11.8. It creates the
owner, the organisation, its default workspace and the owner membership in one transaction,
under the advisory lock `GET_LOCK('tmanage.first_owner_setup', 5)` with the "no organisation, no
owner" check inside it, so it can succeed once only (a concurrent loser gets 404, or 409 if the
lock wait times out). The token is compared in constant time. Requests are rate-limited per IP
on the contact form's budget (`RATE_LIMIT_CONTACT_MAX_REQUESTS` /
`RATE_LIMIT_CONTACT_WINDOW_SECONDS`, default 5 per 10 minutes). Behind the same-origin topology
(§3) the per-IP count depends on the D09 trusted-proxy setting in `deploy.md`.

**After setup, delete `SETUP_TOKEN` from the API slot and restart.** Full rationale and the
request body are in `deploy.md` ("First-owner setup"); the click-by-click hPanel steps are step 10
of `deploy/hostinger/DEPLOY-HOSTINGER.md`.

---

## 6. What is impossible on this plan, and needs a decision

These are decisions, not tasks. Each should be recorded (an ADR is the right home — see the last
item) rather than discovered later as a surprise.

1. **The file loop does not work in production — S3/R2 driver unbuilt (FILE-003).** Production
   forbids the `filesystem` driver (env.ts:492) and the `s3` driver does not exist:
   `apps/api/src/common/storage/storage.module.ts:96` wires an `UnavailableObjectStore` whose
   every method throws (`:64-65`). So with the only production-legal driver named, **there is no
   working object store**: upload, version, approval and download are dead, and the boot is green
   about it. This is not a shared-hosting problem — it would be equally dead on Cloud.
   **Decision:** build FILE-003, **or** ship the alpha with the file loop explicitly disabled in
   the agreement and the UI (`50-BOOTSTRAP` §5: restrictions must be explicit and must not
   silently discard work). Until one of those, `STORAGE_*` and the verify/scan/sweep crons are
   provisioned for a loop that cannot run.

2. **The least-privilege database boundary cannot be reproduced.** `scripts/db/users.sql` issues
   `CREATE USER` and `GRANT`, which need server-global `CREATE USER` and `GRANT OPTION`; shared
   hosting gives neither, so `pnpm db:grants` is refused (the file's own header says: "apply as
   far as the plan permits and record any shortfall"). hPanel can create three MySQL users, but it
   grants each of them **full** privileges on the database. The env schema only compares
   **usernames** (env.ts:469, 482, 485-486), so three hPanel users pass validation while all
   three hold identical privileges — ADR-0001 layer 2 is gone and the boot does not say so.
   **Decision:** accept the degraded boundary for the alpha and record it, or do not deploy on a
   plan that cannot grant table-level privileges. Do not report it as satisfied because the boot
   succeeded.

3. **Malware scanning is off.** You cannot run a clamd on shared hosting, so
   `MALWARE_SCAN_DRIVER=none` (env.ts:385, 493 forbids `stub`). Under `none`, every verified
   version is recorded `unscanned` once and the asset parks at `scanning` forever. Moot while the
   object store is unavailable (item 1), but a live decision the day FILE-003 lands.
   **Decision:** accept `unscanned` files, or provision an external scanning path before files go
   live.

4. **Live chat updates are absent.** `REALTIME_PORT=0` (§2). Accepted; chat still works without
   live updates. Recorded here so it is a decision, not a surprise.

5. **Cron secrets live in a plaintext env file on the server (§4a).** No per-application secret
   store is reachable from the cron shell on this plan. **Decision:** accept the plaintext env
   file (tight permissions, outside `public_html`) as a known shortfall, or move the passes to an
   external scheduler whose secret handling you control (§4b).

6. **The seed-encryption tooling needs dev dependencies on the host.** `mfa:encrypt-seeds` and
   `mfa:seeds-status` run `tsx src/common/database/cli.ts` (`apps/api/package.json`), and `tsx` is
   a devDependency — a production install of built artifacts does not have it. Running the D07
   procedure from `deploy.md` on this host requires pnpm, the TypeScript sources, and dev
   dependencies present. **Decision:** either keep a dev install available for these one-shot
   commands, or run them from a machine that has one and point them at the production
   `DATABASE_MIGRATION_URL`.

7. **Record the divergence from `50-BOOTSTRAP` §3 as an ADR.** Three Node applications became two
   app slots plus cron; the least-privilege boundary degraded (item 2); realtime is off (item 4).
   `docs/implementation-status.md` already says this "belongs in an ADR when a deploy is actually
   attempted". Write it down as decisions.

---

## 7. What genuinely works on this plan today

Given two app slots and a scheduler: sign-in and MFA, organizations and tenancy, invitations with
real email (the API sends them directly), projects, work items and dependencies, client requests
and the client portal, chat without live updates, in-app notifications, audit, idempotency, and
the outbox draining on a one-minute tick. That is most of the product. What is missing is the file
half (item 1) and the security items in §6 — all of them decisions that belong in the alpha
agreement and an ADR, not surprises found after go-live.
