# TManage engineering rules: system design and backend architecture

**Status: binding.** Peter, 2026-11-20: "The system design and the architecture design for the processes in the backend is the most important thing we have."

Every session, agent and worker that designs, builds, reviews or deploys anything in TManage reads this file first. Its brief quotes the sections it touches. Where a rule here conflicts with speed, scope or a deadline, the rule wins. If a task cannot meet a rule, the task stops and the design gets fixed; nobody takes a shortcut.

Related records: `docs/adr/` (decisions with their reasons), `docs/security/`, `docs/runbooks/`. A rule here that changes a decision gets a new ADR.

---

## 1. Principles (the non-negotiables)

1. **One source of truth for every rule.** Every business, security or policy rule is decided in exactly one place on the server: a domain function in `packages/domain` or a single service. This covers permissions, plan limits, feature flags, MFA requirements, visibility, money and dates. The web, worker and AI tools ask the server for the answer, or import the same domain function. They never re-implement it.
   - Known violation: the 2026-11-19 step-up code field. The web demanded a code that the API never required.
2. **The server owns the state; clients never guess it.** The web never infers "signed in", "allowed", "flag on" or "plan" from cookies, local storage, URL shape or an error it did not expect. It reads a server answer that has an explicit type.
3. **Only a definite answer is an answer.**
   - 401 means signed out. 403 means not allowed. 404 means not found or hidden.
   - A timeout, a network error, a 5xx or a restart means **unknown**. Unknown is shown as "can't reach TManage, retrying". It never shows the sign-in form, never shows an empty state, and never counts as "denied" or "nothing there".
   - Known violation: on 2026-11-20 a valid session was shown the sign-in form during a deploy restart.
4. **One shared data model.** There is one table per concept, used by every module. Modules never copy data into their own tables ("departments") to avoid a join. Derived data, such as projections, rollups and caches, is labelled as derived, is rebuilt from the source, and is never written by hand.
5. **Layers stay layers.**
   - Requests flow controller → service → repository → database.
   - Controllers hold no rules. Repositories hold no decisions.
   - Domain logic is a pure function in `packages/domain` wherever it does not need I/O.
   - Modules talk through each other's services or domain events, never through each other's tables.
6. **Reuse before you add.** Before writing a helper, component, endpoint or table, search the graph (`graphify-out/`) and the modules. Do not add a second way of doing what already has a way. No dead code, no copied code, no "v2" left beside "v1".
7. **Exact types end to end.**
   - API shapes are paired in `apps/e2e/contracts/api-web-shapes.ts`.
   - `any`, unchecked casts and stringly-typed status values are not allowed.
   - Inputs are validated at the boundary, once.
8. **Every change is proven.** Each fix or rule has a test that fails when it is removed. That revert proof is run, not assumed. A rule that crosses web and API gets a contract test or an e2e journey.

## 2. Request path and auth

1. **Every request runs the same guard chain:** session → workspace membership (tenant guard) → permission or capability → rate limit → handler. A route is added to the route census and permission map in the same commit, or it does not merge.
2. **Tenant isolation is by query, not by trust.** Every tenant table read or write goes through the tenant guard and carries the workspace id from the session, never from the body (ADR-0001). A cross-workspace test exists for every new table.
3. **Session state comes from one endpoint, used everywhere.** One shared server-verified session check answers for:
   - sign-in, sign-up and verify pages
   - org routes
   - platform admin
   - AI tools
     No page renders workspace chrome or data before that check says "signed in and member".
4. **Step-up and re-authentication rules live in identity.** The server tells the client what it needs: password only, an authenticator code, or an e-mail code with a send button. A field is never required unless the server will check it, and a code is never asked for unless the server can send or verify it.
5. **Redirects.**
   - `next` is a same-origin path only.
   - No session data, token or personal data goes in a URL.
   - Signed-out visitors are redirected before any app markup is sent.
6. **Secrets only in environment variables.** They are never logged, never sent to the client and never committed. Nobody runs a full environment replace on the host.

## 3. Data and migrations

1. **Migrations are forward-only and idempotent where possible.**
   - An applied migration is never edited (0208 above all).
   - Every migration must run on MariaDB 11.8 (live) as well as MySQL 8 (local). That means no generated-column or JSON tricks that MariaDB rejects.
   - Every migration has a test of it being re-run after a mid-file stop.
2. **Least privilege.** The app role gets only the grants its code needs, listed in `users.sql` / `grants.ts` in the same commit as the table (ADR-0007).
3. **Bound SQL only.** No string-built SQL. Raw SQL lives in repositories, never in services or controllers.
4. **Money, time and dates.**
   - Money is an integer of minor units with a currency.
   - Time is stored in UTC and shown in the workspace or user zone through the shared time-zone helper.
   - Day differences use the one shared domain helper. Row times come from a bound `Date`, never from the DB's `current_timestamp` (the admin pool's clock is SYSTEM).
5. **The audit trail is append-only.** Every state change that matters writes one audit row in the same transaction. The trail is never updated or deleted, and its hash chain stays intact.

## 4. Background processes (worker, sweepers, outbox)

1. **Side effects go through the transactional outbox.** A request writes its change and its outbox row in one transaction. The worker delivers mail, notifications, webhooks and AI calls from the outbox. No request handler sends mail or calls a third party inline when it can go through the outbox.
2. **Every job is idempotent.**
   - Delivery is at-least-once, so every consumer must tolerate running twice.
   - Effects are keyed by a natural or idempotency key with a unique index.
   - Notification and signal writes are INSERT-only with dedupe keys.
3. **Every recurring job takes a lease.** A sweeper takes a DB lease (or advisory lock) with an expiry before it runs. Two processes, a restart or a deploy overlap can then never double-run it. A job that dies leaves its lease to expire, never a half-done state that blocks forever.
4. **Bounded work.** Jobs process in pages with a time and row budget, and resume from a cursor. Isolation level is chosen on purpose: READ COMMITTED for counters and budgets that run concurrently. Lock order is fixed, so no deadlocks.
5. **Failure is visible.** Every job records its runs (start, end, rows, error) and has a health signal. A failed job retries with backoff, and after N failures it parks in a dead-letter state that an admin can see. It never fails silently.

## 5. Runtime and deploy (shared hosting)

1. **One app, one process.** Web, API and worker run as one Node app. Boot is:
   1. migrations
   2. schema check
   3. worker
   4. web child
   5. readiness
      Requests that arrive during boot get a 503 with `Retry-After`. They never start a second process.
2. **Readiness is separate from liveness.** `/healthz` means the process is alive. `/healthz/deep` means the DB, migrations, schema and realtime are ready. The web treats a 503 from the API as "unknown, retry", never as "signed out" (§1.3).
3. **Restart is quiet and single.** After a restart nobody sends a request for 3 minutes, then one request, then exactly one process is confirmed. A deploy that leaves two processes is a defect to fix in the process model, not a step to repeat by hand.
4. **Every deploy can be rolled back.** The previous bundle and a verified DB backup exist before the upload. The deploy gates are:
   - `audit:prod` at 0
   - the staged-config guard
   - the bundle lockfile guard
   - a Hostinger vulnerability list that is empty or explained

## 6. AI features

1. **AI acts only through typed tools that call the same services as the UI.** It never writes SQL, never bypasses the guard chain, and never acts beyond the viewer's own permissions.
2. **Sensitive actions show a preview and wait for confirmation, and can be undone where possible.** Every AI action is audited.
3. **Cost is designed in, not added later.**
   - Saved patterns and rules are reused per company and task type.
   - Prompt prefixes are cacheable.
   - Retrieval comes before generation.
   - The model is called only where rules cannot answer.
   - Budgets are enforced on the server with holds.

## 7. How every session works with these rules

1. **Before designing:** read this file, the relevant ADRs and the graph. Write down where the single source of truth for each rule will live.
2. **Every worker brief** names the sections of this file that apply and states both halves: the architecture (layers, reuse, single source of truth, types) and the security (guard chain, tenant scope, bound SQL, secrets).
3. **When a defect is found,** name its class, for example "rule decided twice" or "transient error treated as denied". Fix the class across the codebase, not just the instance, and add the class to the list below.
4. **System-design changes are planned by Fable 5.2 and built by Opus 5.5.** A change to a principle here needs a new ADR and Peter's rule.

## 8. Known defect classes (grow this list; sweep for each before merging related work)

| Class                                                          | First seen                                                      | Rule       |
| -------------------------------------------------------------- | --------------------------------------------------------------- | ---------- |
| Rule decided in two places (web vs API)                        | 2026-11-19 step-up code field                                   | §1.1, §2.4 |
| Transient failure treated as signed out or denied              | 2026-11-20 sign-in form shown to a valid session during restart | §1.3, §5.2 |
| Second process after restart                                   | every deploy up to 2026-11-20                                   | §5.1, §5.3 |
| Worker writes with UPDATE where INSERT-only dedupe is required | 2026-11-19 T1                                                   | §4.2       |
| Concurrency deadlock under load (AI budget)                    | 2026-11-19 T1                                                   | §4.4       |
| Client gets the staff layout on a staff URL                    | 2026-11-19 T4 F7                                                | §2.3       |
