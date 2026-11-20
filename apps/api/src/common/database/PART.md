---
part: api-common/database
kind: api-common
context: platform-operations
owner: implementation-lead
lifecycle: production
depends_on: [package/config]
provides_api: []
consumes_api: []
tables_owned: [schema_migrations]
rules:
  [
    AR-4,
    AR-4b,
    AR-12,
    DA-1,
    DA-2,
    DA-3,
    DA-4,
    DA-5,
    DA-6,
    DA-7,
    DA-8,
    DA-9,
    DA-10,
    DA-12,
    ST-2,
    ST-5,
    ST-7,
    HT-1,
    RT-2,
    RT-8,
    OB-4,
    PR-1,
  ]
ux_rules: []
last_verified_commit: 3b7e4fa70eb6facff3f1dccc65c0867f0707a0a6
last_verified_date: 2026-11-20
last_verified_by: Claude Opus 5.5 (lane E)
---

# api-common/database

## Purpose and bounded context

The API's only door to MariaDB/MySQL: the tenant-bound pool and handle (`TenantDatabase`), the statement-level **tenant guard** (ADR-0001 layer 3), the Drizzle schema and proxy, the forward-only **migrator** with its ledger, the least-privilege **grants** applier, and the `db:*` CLIs. Every API repository receives a `TenantQueryRunner` from here; nothing else gets the pool (`tenant-context.ts:634-640`).

- Context: infrastructure under the shared kernel (VIEWS §4 "Platform Operations" is the nearest; it has no business tables). Upstream: `@tmanage/config` (env), `mysql2`, `drizzle-orm`. Downstream: every `apps/api` module, `apps/server` (migrate on start), DB test harness.
- Not in this part: the worker's own database layer `apps/worker/src/common/database/**` (part `app/worker`).

## Domain model and invariants

Key types: `TenantContext` (`tenant-context.ts:56`, built by `createTenantContext` `:101`, service form `createServiceContext` `:193`), `TenantQueryRunner` (`:235`, with an audited `unscoped(reason)` escape `:255`), `TenantDatabase` (`:642`), `TenantGuardMode = 'enforce' | 'observe'` (`tenant-guard.ts:2498`), `MigrationFile`/`LedgerRow` (`migrator.ts:83,91`).

| # | Invariant (checkable) | Where | Proof |
| --- | --- | --- | --- |
| D-1 | Every statement on a tenant table carries an `organization_id` predicate bound to the context's organization; otherwise `TenantGuardViolation` (enforce) or a security event (observe). | `analyzeStatement` `tenant-guard.ts:1906`, `assertTenantScoped` `:2560`, class `:2518` | `tenant-guard.test.ts:54,60` (47 cases); `apps/api/test/tenant-isolation.db.test.ts` |
| D-2 | Every table is classified: `TENANT_TABLES` (`tenant-guard.ts:67`) or `NON_TENANT_TABLES` (`:1423`); a new table without a decision fails. | `isTenantTable` `:1602` | `schema-conventions.test.ts:130,151`; `tenant-isolation.db.test.ts:207-258` |
| D-3 | Every tenant table has `organization_id CHAR(36) NOT NULL` and `UNIQUE (organization_id, id)` (composite FKs are layer 1). | migrations | `schema-conventions.test.ts:130,135` (revert proof built in: strips the key, expects failure) |
| D-4 | One statement per call: `multipleStatements: false`, so a smuggled second statement cannot pass the per-statement guard. | `connection.ts:29-32` | `tenant-guard.test.ts` |
| D-5 | A pooled connection whose `sql_mode`/UTC session state cannot be set is destroyed, never handed out (STRICT_ALL_TABLES protects CHAR(36) ids). | `connection.ts:143-150`; state `:108-110` | `database.module.test.ts` |
| D-6 | A transaction rolls back on any throw; the audit row and outbox row commit with the state change or not at all. | `tenant-context.ts:656-686` | db suites (`first-owner-transaction.test.ts:46`) |
| D-7 | Errors leave the layer unwrapped and without SQL or bound parameters (no PII in logs). | `unwrapQueryError` `query-error.ts:36-50` | `query-error.test.ts` |
| D-8 | Migrations: ordered, checksummed (`migrator.ts:269`, mismatch refused `:451`), one advisory lock (`GET_LOCK` `:359`; NULL = server error `:364-365` distinct from timeout `:367-371`), ledger per statement (`:320-334`), a single `running` row resumes from `statements_applied`, anything else refuses (`PartialMigrationError` `:142`). | `migrator.ts:21-75` | `migrator.test.ts:10,76,95` |
| D-9 | The migration connection is not pooled (the lock is session-scoped) and has **no** statement timeout (an ALTER must not die half way). | `connection.ts:156-168` | `migrator.test.ts` |
| D-10 | Soft-deleted content (`deleted_at`) is excluded from every list read; restore window 30 days default, ≤ 365. | `content-retention.ts:20-23` | `soft-delete-exclusion.test.ts:189,217` |
| D-11 | Grants equal `scripts/db/users.sql`; excess or missing privileges are reported. | `grants.ts:181,261,266` | `grants.test.ts:64,121,303`; `users-sql.test.ts:165,259,462` |

## Public API and contracts

No HTTP routes. In-process contract (the "published language" every repository uses):

| Export | Where | Use |
| --- | --- | --- |
| `TenantDatabase.transaction(ctx, work, {isolation?: 'read committed'})` | `tenant-context.ts:656`; option `:623-632` | multi-write commands; READ COMMITTED only for conditional-UPDATE counters (AI budget) |
| `.read(ctx, work)` | `:689` | guarded read on one connection |
| `.bootstrapRead` / `.identityRead` / `.identityTransaction` | `:718`, `:739`, `:762` | pre-tenant reads (resolver) and identity tables, with their own scope violations (`BootstrapScopeViolation` `:372`, `IdentityScopeViolation` `:507`) |
| `.firstOwnerTransaction` / `.invitationRegistrationTransaction` | `:804`, `:862` | under `GET_LOCK`; `FirstOwnerLockUnavailableError` `:608` |
| `DatabaseModule.forUrl` / `.forPool`; tokens `TENANT_DATABASE`, `ERASURE_DATABASE` | `database.module.ts:48-92` | Nest wiring; erasure gets its own 1-connection pool when `erasureUrl` is set |
| `createTenantPool`, `createMigrationConnection` | `connection.ts:127`, `:156` | lint allows only this layer to import them (`eslint.config.js:220-246`) |
| `tenantDrizzle(runner)`, `schema` | `drizzle.ts:116,157` | typed queries through the guarded runner |
| `migrate`, `migrationStatus`, `migrateOnStart(url, opts)` | `migrator.ts`, `migrate-on-start.ts:15-25` | CLI and `apps/server/server.mjs:142` boot |
| `unwrapQueryError` | `query-error.ts:36` | the single unwrap at the boundary |
| CLI `pnpm db:migrate | db:status | db:reset | db:grants`, `mfa:*`, `token-vault:upgrade` | `cli.ts:18-19,44` | one-off admin processes (RT-8) |

## Data: tables and migrations

- Owns only `schema_migrations` (`migrator.ts:320-334`): `version` PK, `checksum CHAR(64)`, `status ENUM('running','applied','failed')`, `statements_total/applied`, `failed_statement_index`, `applied_by`, times.
- Hosts the Drizzle schema for every table (`schema.ts`, 15,146 lines) and the guard registry (`tenant-guard.ts:67`, `:1423`). Ownership of those tables belongs to the contexts (AR-7); this layer does not encode it yet.
- Migrations: `apps/api/migrations/*.sql`, 371 files, latest `0383_ai_settings_packs_limit.sql`. Forward-only; 0208 must never be edited (domain-change incident). Compatibility gate `scripts/check-mariadb-compat.mjs` (`pnpm check:mariadb`, in `pnpm verify`): bans `GENERATED ALWAYS AS` (`:34`), `RENAME COLUMN` (`:62`), `->`/`->>` (`:73`), `JSON_TABLE` (`:78`), `MEMBER OF` (`:85`) and others.
- Retention: `retention.content_purge_days` platform setting, read through the runner and cached 30 s per process (`content-retention.ts:13-16`).

## Permissions and tenant rules

- Decision point for **tenant isolation by query** (ADR-0001, DA-12): the guard at statement level; the context comes from `TenantContextGuard` (session), never from a request body.
- Guard mode from env `TENANT_GUARD_MODE`, default `enforce` (`packages/config/src/env.ts:284`), wired at `apps/api/src/app-composition.ts:44`. `observe` is "for a documented incident" (`env.ts:280-283`) but **no production boot refuses it** (gap, ST-7).
- Violations render as **500** with the text dropped (`apps/api/src/common/http/http-exception.filter.ts:30-37,104-116`): a missing predicate is our defect, not the client's.
- Least privilege (DA-9): runtime, migration and erasure credentials differ (`database.module.ts:30-41`); grants live in `scripts/db/users.sql` and are applied by `grants.ts`. Locally the DB suite runs as admin, so a missing grant is invisible there (memory note); `users-sql.test.ts:259` checks the file statically.
- Layer boundary (AR-4): `mysql2`/`drizzle-orm` imports are banned outside `common/database/**` and repositories by `eslint.config.js` (lines 80-81, 176-177, 220-246).

## Runtime, background work and failure modes

- **Pool (ST-2, ST-5):** `connectionLimit = DATABASE_POOL_MAX` (default 5, max 50, `env.ts:277`; `app-composition.ts:42`), `waitForConnections: true`, keep-alive (`connection.ts:128-135`). **No `queueLimit` (mysql2 default 0 = unbounded) and no acquire deadline**: under exhaustion requests queue without bound instead of failing fast. Statement cap `max_statement_time = DATABASE_STATEMENT_TIMEOUT_MS/1000` (default 15 s, `env.ts:278`; `connection.ts:114-117`), tolerated failing on hosts that refuse it (`:111-113,117`).
- **Bulkheads:** separate pools exist for the in-app worker relay (`apps/server/server.mjs:382-385`, ≤ 2) and sweeps (`server.mjs:503-506`, 1), and the erasure pool (1). Good.
- **Isolation and write conflicts (DA-1, DA-2, DC-5):** default REPEATABLE READ; READ COMMITTED opt-in per transaction (`tenant-context.ts:663-667`). There is **no shared write-conflict retry helper**. 1020/1213/1205 handling is re-implemented in `modules/approvals/approval-records.repository.ts`, `modules/copilot/ai-budget.service.ts`, `modules/files/review-threads.repository.ts`, `modules/finance/document-sequences.ts`, `modules/time/locks.service.ts`, `apps/worker/src/common/database/outbox-store.ts`, `apps/worker/src/outbox/dispatcher.ts` (grep at HEAD).
- **DB down / timeout (HT-1):** a driver error (ECONNREFUSED, pool exhaustion, `ER_STATEMENT_TIMEOUT` 1969) is not an `ApiError`, so the filter renders **500** (`http-exception.filter.ts:23-24`), never `503 + Retry-After`. Clients then cannot tell "our DB is restarting" from a defect (DC-1 feeder).
- **Lock outcomes (AS-4 shape):** the migrator separates NULL (error) from 0 (held) (`migrator.ts:364-371`); `firstOwnerTransaction` folds both into `FirstOwnerLockUnavailableError` (`tenant-context.ts:815-817`), so a DB error reads as "another setup in progress".
- **Mid-file kill (DA-8):** the migrator resumes a single `running` row and reads "already exists" errors (1050/1060/1061/1022/1826/1304/1359) on that one statement as applied (`migrator.ts:44-58`). The server waits for the file in progress before exiting on SIGTERM (`apps/server/migration-shutdown.mjs`).
- **Two instances (RT-2, DC-3):** migrations serialize on `GET_LOCK`; the 30 s retention cache is per-instance and harmless. Nothing else here is process-unique.
- **Fail fast (ST-7):** a checksum mismatch or partial ledger throws in `migrate`, so `apps/server` boot fails rather than serving a drifted schema.

## UX rules for its screens

n/a — reason: infrastructure layer with no screens.

## Standards that apply

| Rule | Today | Target |
| --- | --- | --- |
| AR-4 | Met by lint (`eslint.config.js:220-246`). | Keep; add repositories glob proof. |
| AR-4b | `cli.ts` and the migrator issue DDL only from migration files; `LEDGER_DDL` (`migrator.ts:319`) is the one in-code DDL (the ledger itself). | Document as the sanctioned exception. |
| DA-1 | Mechanisms exist (unique keys, version CAS, `GET_LOCK`), anomaly not named per write path. | Write-path register; reviewers reject unnamed anomalies. |
| DA-2 | **Missing:** 7 local retry implementations. | One `withWriteConflictRetry(work, {attempts, jitter})` here around the whole transaction; grep check banning local 1020/1213 handling. |
| DA-3 | Parameters bound (`SqlParameter` `tenant-context.ts:219`); raw-SQL lint. | Keep. |
| DA-4 | Checksum refusal (`migrator.ts:451`). | Keep. |
| DA-5 | `check-mariadb-compat.mjs`. Doc drift: `connection.ts:84` says MariaDB 11.8 is "the one engine … development, the test suites", while DA-5 requires MariaDB 11.8 **and** MySQL 8. | Reconcile the comment with the standard. |
| DA-6 | **No check** for destructive DDL (`DROP COLUMN/TABLE`, `MODIFY` narrowing, `NOT NULL` without default). | Expand-contract lint in `check-mariadb-compat.mjs` (contract steps need an ADR'd release). |
| DA-7 | Not checked. | Require `ALGORITHM`/`LOCK` on hot-table ALTERs. |
| DA-8 | Met (resume path, `migrator.ts:44-58`). | Keep; db test for resume. |
| DA-9 | Met (`grants.ts`, `users-sql.test.ts`). | Run the least-privilege proof against MariaDB (open gap: only proven on MySQL 8). |
| DA-10 | UTC session (`connection.ts:108`), `timezone: 'Z'` (`:35`). Some writes still use `current_timestamp(3)` on the runtime pool (e.g. `modules/tenancy/memberships.repository.ts:404`). | Bound `Date` for row times where tests compare them. |
| DA-12 | Met (D-1, D-2). | Refuse `observe` in production boot. |
| ST-2 | Statement timeout and pool size set; **queue limit not set**. | `queueLimit` + acquire deadline; pool-wait metric (OB-3). |
| ST-7 | Schema drift refused; guard mode `observe` accepted silently. | Boot guard in `apps/server/boot-guards.mjs`. |
| HT-1 | DB outage → 500. | Map connection/timeout/pool errors to `503 + Retry-After` in the filter (one classifier). |
| OB-4 | Correlation id is in guard events (`TenantGuardEvent.correlationId`, `tenant-guard.ts:2507`). | Carry into outbox rows (platform part). |

## How to change this part

1. **New table:** migration `apps/api/migrations/NNNN_name.sql` (next free number, MariaDB-safe, expand-only); Drizzle table in `schema.ts`; classify in `TENANT_TABLES` or `NON_TENANT_TABLES` (`tenant-guard.ts:67/1423`); grants in `scripts/db/users.sql`; a cross-tenant db test. Run `pnpm check:mariadb`, `schema-conventions.test.ts`, `users-sql.test.ts`.
2. **New transaction kind:** add a method on `TenantDatabase` only if the scope differs (identity, bootstrap); otherwise use `transaction`/`read`. Never hand the pool out.
3. **Never** edit an applied migration; never add an in-code DDL; never import `connection.ts` outside this folder.
4. Checks: `pnpm --filter @tmanage/api typecheck`, unit tests in this folder, `pnpm test:db` (≈30 min; real MariaDB).

## Tests and fitness checks

- Unit (this folder): `tenant-guard.test.ts` (47 cases), `schema-conventions.test.ts`, `mariadb-compat.test.ts:44`, `migrator.test.ts`, `grants.test.ts`, `users-sql.test.ts`, `query-error.test.ts`, `drizzle-dates.test.ts`, `soft-delete-exclusion.test.ts`, `database.module.test.ts`, `first-owner-transaction.test.ts`, `guard-event-log.test.ts`, `data-inventory.doc.test.ts`, `ai-ledger-migrations.test.ts`.
- DB: `apps/api/test/tenant-isolation.db.test.ts` (adversarial two-tenant pair, `seed-two-tenants.ts`), `apps/api/test/t1-1119-ai-budget.db.test.ts` (200 racers, READ COMMITTED path).
- Fitness in `pnpm verify`: `check:mariadb`; ESLint driver boundary. **Missing:** DA-2 grep check, DA-6 destructive-DDL check, ST-2 pool-config test, guard-mode boot check.

## Open defects, decisions and risks

| Id | Class | Finding | Pri | Exit |
| --- | --- | --- | --- | --- |
| DB-D1 | DC-5 | No shared write-conflict retry (7 copies). | P1 | `withWriteConflictRetry()` here + grep fitness check + N-racer tests (sequences, time locks). |
| DB-D2 | DC-1 | DB unavailability renders 500, not 503 + `Retry-After` (HT-1). | P1 | Classify driver errors in `HttpExceptionFilter`; unit table test. |
| DB-D3 | ST-2 | Pool queue unbounded (no `queueLimit`, no acquire deadline). | P1 | Set both from env; test that the N+1th waiter fails fast. |
| DB-D4 | DA-6 | No expand–contract check; a destructive migration would break the overlapping old process (RT-3). | P1 | Extend `check-mariadb-compat.mjs`. |
| DB-D5 | AS-4 shape | `firstOwnerTransaction` folds a `GET_LOCK` NULL (error) into "held". | P2 | Separate outcomes like `migrator.ts:364-371`. |
| DB-D6 | ST-7 | `TENANT_GUARD_MODE=observe` accepted in production. | P2 | Refuse at boot unless an incident flag is set. |
| DB-D7 | AR-5 | `cli.ts` (common layer) imports `modules/identity` and `modules/connectors` (`cli.ts:6-12`). | P2 | Move those subcommands to their modules' CLIs. |

ADRs: ADR-0001 (tenant isolation by query), ADR-0007 (least-privilege grants and DDL placement).

## Glossary

| Term | Meaning |
| --- | --- |
| Tenant guard | Per-statement analyzer that refuses SQL on tenant tables without the org predicate. |
| Ledger | `schema_migrations`, one row per migration with per-statement progress. |
| Enforce/observe | Guard modes: throw vs record a security event only. |
| Unscoped | An audited escape on the runner for a statement that legitimately spans tenants. |
