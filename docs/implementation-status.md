# TManage — implementation status

Status vocabulary is fixed by `15-AI-EXECUTION-HANDBOOK.md` §6:
`not_started` · `designed` · `design_validated` · `contract_defined` · `implemented` ·
`tested` · `release_ready` · `released`.

A row is only `tested` if a check was **actually executed** and its result recorded below.

**Last updated:** 2026-08-25 · **Deployment profile:** `bootstrap` (50-BOOTSTRAP)

---

## Machine and toolchain — read before running anything

Recorded because two things about this machine have changed since the last session, and both
change what a command does rather than merely how it is typed.

| Fact                      | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **pnpm is not installed** | There is no `pnpm` on `PATH`. Provision it with `corepack enable pnpm --install-directory <dir>` and prepend that directory. Inside the repository it then resolves to **10.15.0** via `packageManager`, verified before any gate was run this session. Note for a POSIX shell on Windows: `PATH` entries must be `/c/Users/...`, not `C:/Users/...` — a drive-letter colon is a `PATH` separator, so the entry is silently discarded                              |
| Node                      | 22.22.0 · corepack 0.34.0                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Git state**             | The repository now has one commit (`3206036`). `user.name` / `user.email` are set repo-locally. **No remote.** Nothing is pushed                                                                                                                                                                                                                                                                                                                                   |
| Containers                | Unchanged and still absent: no Docker, no container runtime, no WSL, no local MySQL or MariaDB. `pnpm test:db` works regardless — it runs a real embedded MySQL 8.0.45 (ADR-0002)                                                                                                                                                                                                                                                                                  |
| File encoding             | Source must not be edited through PowerShell `Get-Content` / `Set-Content`: it re-encodes UTF-8 and corrupts every em dash and `§` in this codebase's comments. Bash heredocs with a quoted delimiter are safe                                                                                                                                                                                                                                                     |
| **A stale second copy**   | `outputs/TManage-Planning-Pack/tmanage/` is a duplicate of this repository and is **stale as of 2026-08-24**: it is missing every file from the HTTP-surface and PROJ-001 sessions, its `implementation-status.md` is an older revision, and its git repository holds **zero commits**, so it preserves nothing this one lacks. Kept on purpose (Peter's decision, 2026-08-25). **Never edit it and never read it as current** — the live repository is `tmanage/` |

---

## Planning-pack reconciliation — re-verified 2026-08-25, start of the least-privilege session

Run before a line of code was written, for the reason the re-baseline notice below gives.
This is the **sixth** consecutive run with the same result, and the table below is that
run's output, not a copy of the previous one.

Also confirmed on 2026-08-25: the only pack content not copied into the repository is the
design-handoff `.zip` (extracted into `docs/design/source/`), `TManage-Product-System-Master-Plan.docx`,
and Claude Code's own tooling for the pack folder. Nothing under `docs/planning/` or
`docs/design/source/` was written to this session.

| Scope                                     | Result                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/planning/` vs the pack (SHA-256)    | **61 of 61 byte-identical.** 0 differ, 0 missing, 0 extra                                                                                                                                                                                                                                                                     |
| `docs/design/source/` vs the pack handoff | **147 of 147 byte-identical.** 0 differ, 0 missing, 0 repo-only                                                                                                                                                                                                                                                               |
| Modification times                        | **No pack file is newer than its copy**, checked pair by pair rather than by comparing the two newest                                                                                                                                                                                                                         |
| Uncopied pack content                     | The same 2, both deliberate: the design-handoff `.zip` (extracted into `docs/design/source/`) and `TManage-Product-System-Master-Plan.docx`. Three further pack-root files are Claude Code's own tooling for that folder — `CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json` — and are not planning content |
| Conclusion                                | Nothing revised since the last check. Safe to write code                                                                                                                                                                                                                                                                      |

Nothing under `docs/planning/` or `docs/design/source/` was written to this session. A stale
copy is refreshed _from_ the pack and never authored.

---

## ⚠️ Re-baseline notice — 2026-08-16

Work began against the planning pack as it stood at 08:35. The pack was **revised at
09:26–11:11 the same day**, changing the database engine and renaming a source file:

| Change           | Before                             | After                                                |
| ---------------- | ---------------------------------- | ---------------------------------------------------- |
| Primary database | PostgreSQL + forced RLS            | **Hostinger MySQL-compatible MariaDB**               |
| Access layer     | (unspecified)                      | **Drizzle ORM + `mysql2` + explicit SQL migrations** |
| File 25          | `25-AUTHORIZATION-AND-RLS-SPEC.md` | `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md`      |
| New              | —                                  | `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY.md`      |
| New              | —                                  | `50-BOOTSTRAP-DEPLOYMENT-ON-ONE-PAID-PLAN.md`        |

The PostgreSQL data layer built before the revision (3 migrations, migrator, tenant
transaction, isolation suite) has been **removed**, not adapted. The engine-agnostic
packages were unaffected and still pass.

**Consequence for the security model:** MySQL has no row-level security, so the backstop is
now five application/schema-layer controls — see `ADR-0001`. This is a genuine reduction in
one specific respect, documented there rather than glossed over.

### Planning-pack reconciliation — re-verified 2026-08-16, start of the ID-001 session

Run again before a line of code was written, for the reason the notice above gives.

| Scope                                     | Result                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `docs/planning/` vs the pack (SHA-256)    | **61 of 61 byte-identical.** 0 differ, 0 missing, 0 extra                                               |
| `docs/design/source/` vs the pack handoff | **147 of 147 byte-identical.** 0 differ, 0 extra                                                        |
| Uncopied pack files                       | The same 2, both deliberate: the design-handoff `.zip` and `TManage-Product-System-Master-Plan.docx`    |
| Newest pack mtime vs its copy             | No pack file is newer than the copy that consumed it (newest pack file: 11:11; newest repo copy: 11:14) |
| Conclusion                                | Nothing revised since the 17:30 check. Safe to write code                                               |

Re-run **after** the session's work as well: **0 files differ.** Nothing under `docs/planning/`
or `docs/design/source/` was written to, which is the point — a stale copy is refreshed _from_
the pack and never authored.

### Planning-pack reconciliation — re-verified 2026-08-16, start of the TEN-001/TEN-002 session

Repeated in full again, for the same reason: the pack has been revised mid-build once.

| Scope                                     | Result                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/planning/` vs the pack (SHA-256)    | **61 of 61 byte-identical.** 0 differ, 0 missing, 0 extra                                                                                                                       |
| `docs/design/source/` vs the pack handoff | **147 of 147 byte-identical**                                                                                                                                                   |
| Uncopied pack files                       | 2, both deliberate: the design-handoff `.zip` (extracted into `docs/design/source/`) and `TManage-Product-System-Master-Plan.docx`, a binary rendering of Markdown already held |
| Newest pack mtime vs its copy             | No pack file is newer than the copy that consumed it                                                                                                                            |
| Conclusion                                | Nothing revised since the 13:35 check. Safe to write code                                                                                                                       |

### Planning-pack reconciliation — re-verified 2026-08-16, start of the PLAT-003 session

Repeated in full before any code was written, because the pack has been revised mid-build
once already.

| Scope                                     | Result                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| `docs/planning/` vs the pack (SHA-256)    | **61 of 61 byte-identical.** 0 differ, 0 missing, 0 extra                                   |
| `docs/design/source/` vs the pack handoff | **147 of 147 byte-identical**                                                               |
| Newest pack mtime                         | `contracts/tmanage-core.dbml`, `00-README.md` — 11:11                                       |
| Newest repo copy mtime                    | `docs/planning/00-README.md` — 11:14                                                        |
| Conclusion                                | No pack file is newer than the copy that consumed it; nothing revised since the 12:00 check |

### Planning-pack reconciliation — verified 2026-08-16 12:00

`docs/planning/` was diffed file-by-file (SHA-256) against
`outputs/TManage-Planning-Pack/` before any code was written this session.

| Result                         | Detail                                                                                                                                                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 59 of 60 files byte-identical  | No extra files in `docs/planning/`, none missing                                                                                                                                                                                                                |
| 1 file stale                   | `contracts/tmanage-core.dbml` — copied 11:05:27, pack revised 11:11:15                                                                                                                                                                                          |
| Difference                     | A 5-line header: MySQL/MariaDB starter, UUIDv7 as canonical lowercase `CHAR(36)`, `datetime(3)` UTC, composite `(organization_id, id)` keys and composite tenant FKs required before production reads or writes. The 400-line table body was already identical. |
| Action                         | That one file re-copied from the pack. No planning content authored or altered.                                                                                                                                                                                 |
| Residual PostgreSQL references | 5, all deliberate contrast ("MySQL has no PostgreSQL-style RLS"). Zero `jsonb`, `gen_random_uuid`, or `citext`.                                                                                                                                                 |

The MySQL revision is fully landed in `docs/planning/`.

---

## Verification actually run — 2026-08-25, the least-privilege session

This session did one thing the previous six could not: it ran **ADR-0001 layer 2** against a
real server. `scripts/db/users.sql` had been written, reviewed, statically asserted and
never executed anywhere. It has now been executed, and the twenty cases that guard it **ran**
rather than skipping.

No container was involved and none is claimed. The server was a **single long-lived embedded
MySQL 8.0.45** — the same binary `mysql-memory-server` already downloads for the per-file
path (ADR-0002), started once outside the per-file lifecycle so that one database could be
migrated, granted, and then shared by every suite. That is the configuration
`TMANAGE_TEST_DATABASE_URL` was designed for; it had simply never been pointed at anything
except a container this machine does not have.

### The sequence, exactly as run

| Step | Command                                                                                                   | Result                                     |
| ---- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1    | long-lived embedded server, `dbName: 'tmanage'`                                                           | up on `127.0.0.1:29579`                    |
| 2    | `DATABASE_MIGRATION_URL=mysql://root@127.0.0.1:29579/tmanage pnpm db:migrate`                             | **applied 3 migrations, 31 statements**    |
| 3    | `DATABASE_MIGRATION_URL=<root url> pnpm db:grants`                                                        | **applied 26 statements from `users.sql`** |
| 4    | `pnpm --filter @tmanage/api test:db` with `TMANAGE_TEST_DATABASE_URL` and `TMANAGE_TEST_APP_DATABASE_URL` | **10 files, 321 passed, 0 skipped**        |
| 5    | server stopped, then `Get-Process mysqld`                                                                 | **no `mysqld` running** — no stray left    |

The database cannot be named `tmanage_test`: every grant in `scripts/db/users.sql` names
`tmanage` literally, so the credential exists only on a database of that name. Step 3 must
follow step 2 because every grant is table-level, and MySQL rejects a table-level `GRANT`
naming a table that does not exist.

The run reported its own provenance, repeated here rather than paraphrased:
`engine=mysql 8.0.45 · server=external (TMANAGE_TEST_DATABASE_URL) · runtime credential=tmanage_app (least privilege)`.

### What that closes, and what it does not

**Closed — three things that had never been observed:**

1. `scripts/db/users.sql` executes against a real server. All 26 statements applied.
2. The grants are the ones the file claims. `SHOW GRANTS FOR 'tmanage_app'@'%'` returns
   `USAGE` globally, `SELECT` on the `tmanage` database, `INSERT/UPDATE/DELETE` on the
   thirteen named tables, `INSERT` alone on `audit_events` and `session_refresh_tokens`, and
   **nothing at all on `schema_migrations`** — which is therefore readable through the
   database-wide `SELECT` and writable by no one but the migrator.
3. ADR-0001 layer 2 is proven dynamically rather than only statically. The runtime
   credential was measured, not asserted.

**Not closed:** the engine is still MySQL. MariaDB remains untested, the MySQL-vs-MariaDB
skew is still deferred to CI, and CI has still never run. Nothing here was containerised.

### Four defects the first real run found

A suite that skips proves nothing, and this one had been skipping since it was written.
Running it found four faults — three in the suite, one in a log line — and none of them
could have surfaced any other way.

| #   | Defect                                                                                                                                                 | Why it stayed invisible                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Seeded without truncating first, so `seedTwoTenants`' fixed slugs collided with `uq_organizations_slug`                                                | On the per-file embedded server every file gets an empty database of its own. Every sibling suite truncates; this one never had to                                   |
| 2   | The migration-ledger case named columns that do not exist — `filename` and `state`, where the table has `version`, `name`, `status`                    | **The assertion could not have proved what it claimed in any environment.** The `INSERT` would have been rejected for naming an unknown column, not for privilege    |
| 3   | The `CREATE TRIGGER` case required `ER_TABLEACCESS_DENIED_ERROR`, but with binary logging on MySQL reports `ER_BINLOG_CREATE_ROUTINE_NEED_SUPER` first | `log_bin = 1` is the MySQL 8 default. Both codes are the privilege system refusing and neither is the append-only trigger, which is the distinction the file keeps   |
| 4   | The session-state case read a bare connection's inherited `sql_mode` and required `STRICT_ALL_TABLES` to be set already                                | It held only because `compose.yaml` launches its MariaDB with `--sql-mode=STRICT_ALL_TABLES,...`. It asserted a server's start-up flags in a file about a credential |

Defect 4 matters beyond this run. **Hostinger's shared MySQL cannot be given server start-up
flags**, and 50-BOOTSTRAP targets exactly that environment. The case now asserts what the
credential actually owns — that `tmanage_app` can _establish_ the session state itself,
which is what `createTenantPool` does on every connection it hands out — and a second case
covers the guarded pool, the path the application really uses. That is strictly stronger:
the old assertion passed whether or not the runtime user held the privilege to set anything.

**No assertion was weakened.** Cases 3 and 4 accept a wider range of servers and a narrower
range of behaviour.

### One false claim removed

The isolation corpus printed `server=containerised (compose.yaml)` for **any** external URL,
including this run, which used no container. `external` means only that
`TMANAGE_TEST_DATABASE_URL` was supplied. The label now reads
`external (TMANAGE_TEST_DATABASE_URL)`, and the engine and version printed beside it are
what distinguish CI's MariaDB from a local MySQL. The CI assertions that _require_ MariaDB,
an external server and the least-privilege credential are unchanged.

Separately, the non-CI branch of `guards CI against a silent skip` logged
`skipped — no TMANAGE_TEST_APP_DATABASE_URL` unconditionally. The first local run that did
supply the credential therefore printed "skipped" beside twenty cases that had in fact
executed. It now reports which of the two actually happened.

### The full chain, re-run afterwards on the default path

`pnpm format` was run and its reformatting committed **before** these numbers were taken.

| Check          | Command             | Result                                                | Ran against                                     |
| -------------- | ------------------- | ----------------------------------------------------- | ----------------------------------------------- |
| Format         | `pnpm format:check` | **exit 0**                                            | prettier 3.6                                    |
| Typecheck      | `pnpm typecheck`    | **exit 0**                                            | tsc 5.9                                         |
| Lint           | `pnpm lint`         | **exit 0** — 0 errors, 0 warnings                     | eslint 9                                        |
| Unit tests     | `pnpm test`         | **211 passed, 10 files, exit 0**                      | node 22.22                                      |
| Database tests | `pnpm test:db`      | **300 passed, 21 skipped, 10 files, exit 0** (~396 s) | **real MySQL 8.0.45** via `mysql-memory-server` |
| Design audit   | `pnpm audit:design` | **exit 0** — 172/172 screen IDs across 29 artifacts   | `docs/design/source/`                           |
| Format (again) | `pnpm format:check` | **exit 0**                                            | after `audit:design` rewrote its output         |

The skip count on the default path is **21, not the previous session's 20**, because the
least-privilege file gained a case. On that path the credential does not exist, so those
cases skip; on the long-lived-server path in the table above every one of them ran and the
total was **321 passed, 0 skipped**. Both numbers are real and they do not conflict — they
are the same suite under two configurations.

---

## Verification actually run — 2026-08-24, the HTTP-surface and PROJ-001 session

Kept as the record of that session. Where it says the least-privilege credential "only
exists once `scripts/db/users.sql` has been applied to the containerised MariaDB", that was
the belief at the time and it was wrong: a long-lived embedded server does just as well, as
the 2026-08-25 section above now shows.

Every gate below was executed on **2026-08-24** in the order the task specified, on this
machine, against the drivers named in the last column. Prettier reformatted this session's
new files _before_ the numbers were recorded, which is why the first `format:check` is green
rather than "green after a fix".

| Check          | Command             | Result                                                | Ran against                                     |
| -------------- | ------------------- | ----------------------------------------------------- | ----------------------------------------------- |
| Format         | `pnpm format:check` | **exit 0** — all matched files                        | prettier 3.6                                    |
| Typecheck      | `pnpm typecheck`    | **exit 0** — 3 projects                               | tsc 5.9                                         |
| Lint           | `pnpm lint`         | **exit 0** — `eslint .`, 0 errors 0 warnings          | eslint 9                                        |
| Unit tests     | `pnpm test`         | **211 passed, 10 files, exit 0**                      | node 22.22                                      |
| Database tests | `pnpm test:db`      | **300 passed, 20 skipped, 10 files, exit 0** (~148 s) | **real MySQL 8.0.45** via `mysql-memory-server` |
| Design audit   | `pnpm audit:design` | **exit 0** — 172/172 screen IDs across 29 artifacts   | `docs/design/source/`                           |
| Format (again) | `pnpm format:check` | **exit 0** — re-run _after_ `audit:design`            | see "the chain was self-defeating" below        |

Unit-test breakdown (211): `packages/config` 25 · `packages/domain` 75 ·
`apps/api` 111 (tenant-guard analyser 45, session cookie and token primitives 27,
**CSRF 16 (new)**, `users.sql`/schema agreement 12, migration statement splitter 9,
**Nest DI under esbuild 2 (new)**). The 18 added cases are the two bolded files, both from
this session's HTTP work.

Database-test breakdown (300 passed / 20 skipped) — **91 more than the previous session's
209**: 49 from the new PROJ-001 repository file, 36 from the new HTTP pipeline file, and 6
added to `sessions.db.test.ts` for the session routes driven through real HTTP.

| File                               | Cases             |
| ---------------------------------- | ----------------- |
| `proj-001-repositories.db.test.ts` | **49 (new)**      |
| `schema.db.test.ts`                | 47                |
| `tenant-isolation.db.test.ts`      | 45                |
| `sessions.db.test.ts`              | 43 (37 + 6)       |
| `http-pipeline.db.test.ts`         | **36 (new)**      |
| `membership-resolver.db.test.ts`   | 24                |
| `tenancy-repositories.db.test.ts`  | 21                |
| `projects-repository.db.test.ts`   | 18                |
| `migrator.db.test.ts`              | 16                |
| `least-privilege.db.test.ts`       | 1 run, 20 skipped |

The run reported its own provenance and it is repeated here rather than paraphrased:
`engine=mysql 8.0.45 · server=embedded (ADR-0002) · runtime credential=admin`. Nothing in
this table was produced by a container.

The 20 skips are ADR-0001 layer 2 and are **not** a passing result. They require the
`tmanage_app` credential, which only exists once `scripts/db/users.sql` has been applied to
the containerised MariaDB. They are reported as skipped here rather than quietly counted —
and the suite fails outright if it ever finds itself skipped with `CI` set (below).

### The lint boundary was verified to fire, not merely to pass

A rule that matches nothing also exits 0. A temporary file under `apps/api/src/features/`
importing `mysql2/promise` and holding two raw SQL strings produced **3 errors** — one
`no-restricted-imports`, two `no-restricted-syntax` — and was then deleted. `pnpm lint`
returns to exit 0 with the allowlisted database modules, which do hold SQL, unflagged.

### The CI guards were verified to fire, not merely to pass

Same treatment the lint boundary got, and for the same reason: a guard that cannot fail is
decoration. Two assertions exist purely to stop CI reporting green while proving less than
this document claims, so both were run with `CI=1` on this machine, where neither the
containerised stack nor the least-privilege credential is available:

| Guard                                                                 | With `CI=1` here                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| corpus: "records which engine and which credential produced this run" | **fails** — "CI must run the containerised stack, not the embedded server" |
| least-privilege: "guards CI against a silent skip"                    | **fails** — "TMANAGE_TEST_APP_DATABASE_URL must be set in CI"              |

Both pass with `CI` unset, which is the correct local behaviour. Without them, a CI job
that lost its service container or its credential would still exit 0.

The 12 new `users.sql`/schema agreement assertions were mutation-tested the same way:
re-adding the `docker-entrypoint-initdb.d` mount to `compose.yaml` and widening one grant
to a database-wide `UPDATE` produced **4 failures**, naming both mistakes. Both mutations
were reverted and the files confirmed byte-identical by SHA-256.

### Defects found by these gates and fixed at the root

_From the ID-001 work (this session). Numbering below is per-block; the items under the
earlier headings keep the numbers other sections refer to._

- **The migrator suite hard-coded the migration set, so adding a migration turned it red.**
  Four cases in `migrator.db.test.ts` listed `0001_tenancy.sql` and
  `0002_platform_primitives.sql` by name and asserted `alreadyApplied` was `[1, 2]`. None of
  them is about the number two: what they check is that _every_ file applies once, in order,
  with a checksum, and that a second run is a no-op. As written, the next migration — any
  migration — would fail them, and the obvious repair is to edit the expected numbers without
  reading what the case is for.

  Fixed by reading the directory instead, plus a new case asserting the directory is not
  empty. Without that guard every assertion in the block becomes vacuously true if the path
  ever mis-resolves, which is a worse failure than the one being fixed.

_From the TEN-001/TEN-002 work (previous session):_

0. **The Drizzle seam silently dropped a column whenever two selected columns shared a
   name.** Drizzle's proxy dialect maps result columns **positionally**, and the seam was
   feeding it `Object.values(row)` from mysql2's default object rows — which are keyed by
   _unqualified_ column name. The membership resolver's first join selects
   `organizations.id` and `memberships.id`, plus `organizations.updated_at` and
   `memberships.updated_at`: four columns arriving as two keys. Every later value then
   shifted left into the wrong field, and the first symptom was a date decoder failing on a
   value that was not a date.

   This had been latent since the seam was written. `ProjectsRepository.listByWorkspace`
   joins two tables but selects columns from only one of them, so nothing in the existing
   18 repository cases or 44 corpus cases could reach it. It would have surfaced on whichever
   join happened to be written next — as a wrong value rather than as an error, if the
   colliding columns had been the same type.

   Fixed at the driver rather than by convention: the runner gained a narrow
   `rowsAsArray` statement option and the seam asks for positional rows, so the ambiguity
   does not exist to be resolved. The alternative — aliasing every column in every future
   join — is a rule someone has to remember, and this is a rule nobody can forget.

_From the PLAT-003 work:_

1. **`scripts/db/users.sql` could never have run where it was mounted.** `compose.yaml`
   mounted it into `/docker-entrypoint-initdb.d/`, which executes on the server's first
   boot — necessarily before any migration. Every grant in the file is table-level, and
   both MySQL and MariaDB reject a table-level `GRANT` naming a table that does not exist
   (`ER_NO_SUCH_TABLE`). The mount is removed and the file is applied by `pnpm db:grants`
   after `pnpm db:migrate`. Nothing in the repository could previously have noticed,
   because nothing compared the two files; `src/common/database/users-sql.test.ts` now does.
2. **`users.sql` required a privilege it was never going to be given.** It issues
   `CREATE USER` and `GRANT`, which need the server-global `CREATE USER` privilege and
   `GRANT OPTION`. `tmanage_migrator` holds privileges on the `tmanage` database only, so
   applying the file as the migration user fails — correctly. Provisioning credentials is
   an administrative act separate from migrating a schema; CI now runs `db:grants` as root
   and the CLI says so explicitly when it sees an access-denied error.
3. **Two comments in `users.sql` described privileges the grants did not deliver.** The
   file claimed `schema_migrations` was "absent, only the migrator writes it" while
   granting `INSERT` on `tmanage.*` — so the runtime user could have forged ledger rows.
   Fixed by tightening rather than by correcting the comment: `SELECT` stays database-wide,
   every write privilege is now table-level, and `audit_events` gets `INSERT` alone.
4. **The gate chain was self-defeating.** `pnpm audit:design` regenerates
   `docs/design/design-source-audit.md` with unaligned Markdown tables, which
   `pnpm format:check` then rejects — so running the sixth gate turned the first one red.
   The generator now formats its own output through the repository's Prettier config and is
   idempotent: two consecutive runs produce identical SHA-256, and `format:check` passes
   after `audit:design`. Adding the file to `.prettierignore` was rejected as the fix; it is
   committed and read by people.

_From the previous session's gates, retained:_

5. **`pool.on('connection')` delivers a callback-style connection**, not the promise-wrapped
   `PoolConnection` its `mysql2/promise` types declare. The session-state setup therefore
   never resolved, the destroy-on-failure policy fired, and every pooled connection was
   torn down — surfacing as 20 cascading `write after end` failures that looked like test
   bugs. Fixed by recovering the wrapper through `.promise()`, and made permanently visible
   by an `onConnectionError` hook the corpus asserts is empty.
6. **`fileParallelism` was set at vitest project level**, where it is silently ignored.
   Caught the first time the vitest config was typechecked (see below); moved to root.
7. `PartialMigrationError` shadowed `Error.cause` without `override`.
8. mysql2's `execute`/`query` overload sets are not callable through a dynamic index.

None was suppressed, and no test, type, or constraint was weakened to clear a gate. Defect 3
was fixed by making the grants stricter than they were, not by relaxing the claim.

### Typecheck now covers `test/`

`apps/api` gained `tsconfig.typecheck.json`, which includes `test/**` and `vitest.config.ts`
alongside `src/`. The build config still excludes them. The isolation corpus is the evidence
for ADR-0001, and evidence that does not compile is not evidence — defect 2 above was found
by exactly this change.

`pnpm typecheck`, `pnpm test`, and `pnpm test:db` now build `packages/**` first, because
`@tmanage/*` resolve through `node_modules` to emitted `dist/*.d.ts`. Without it the gates
pass only on a machine where someone happened to have run a build.

### `format:check` is no longer red by default

It failed on **13** files (the previous entry said 12; `docs/implementation-status.md`
itself had since joined them). All were pre-existing prose and source untouched by any
task. They were formatted in a single isolated pass with no other edit mixed in —
`prettier --write` over exactly those 13 paths, then `format:check`, `typecheck`, `lint`,
`test` and `test:db` re-run to confirm nothing behavioural moved.

Excluding them was considered and rejected. Five of the thirteen are the ADRs and this
document — the files a reader is most likely to open — and a `.prettierignore` entry would
have made the gate green by narrowing what it inspects, which is the failure it exists to
prevent.

### Not yet run — and why

| Check                             | Status                                                                                                                                                                                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The CI workflow itself**        | **Never executed.** `.github/workflows/ci.yml` is written and its YAML parses, but there is no runner here and GitHub Actions has not run it. Everything in the next section marked _pending CI_ rests on it.                                        |
| `scripts/db/users.sql`            | **Executed 2026-08-25 against a real MySQL 8.0.45.** All 26 statements applied, `SHOW GRANTS` matches the file, and the 20 least-privilege cases ran rather than skipping. ADR-0001 layer 2 is now proven dynamically on MySQL — **not** on MariaDB. |
| MariaDB engine                    | Local is **MySQL 8.0.45**. The MySQL-vs-MariaDB gap is unchanged: the workflow that closes it exists, but has not run.                                                                                                                               |
| `compose.yaml`                    | **Still unstarted.** No container runtime on this machine. The removed init-mount is a reasoned correction, not an observed failure.                                                                                                                 |
| gitleaks / `pnpm audit`           | **Both now executed locally on 2026-08-25 — see below.** Neither needed Docker or a runner.                                                                                                                                                          |
| OpenAPI / event-schema validation | `packages/contracts` not yet scaffolded.                                                                                                                                                                                                             |
| E2E, a11y, RTL, visual regression | Depend on `apps/web`, not yet scaffolded.                                                                                                                                                                                                            |
| Backup/restore rehearsal          | Requires a deployed environment.                                                                                                                                                                                                                     |

No check above is claimed as passing.

### The two scans, run locally on 2026-08-25 — and the high-severity finding

Neither scan needs a container runtime or a CI runner, so both were run on this machine
rather than left waiting for a first CI run. **One found a real, gating defect.**

| Scan                                | Command run here                                                                                                  | Result                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Dependency audit (gating, `--prod`) | `pnpm audit --prod --audit-level=high`                                                                            | **Was exit 1. Now exit 0** after the fix below |
| Dependency audit (full)             | `pnpm audit --audit-level=low`                                                                                    | 1 moderate remains — dev-only, see below       |
| Secret scan, git history            | `gitleaks 8.30.1 detect --source . --config .gitleaks.toml --redact --exit-code 1`                                | **no leaks found** (1 commit, 3.60 MB)         |
| Secret scan, working tree           | as above plus `--no-git`, because this session's files are not committed and history alone would have missed them | **no leaks found** (3.93 MB)                   |

**The finding, and what was done about it.** `pnpm audit --prod` reported
[GHSA-gpj5-g38j-94v9](https://github.com/advisories/GHSA-gpj5-g38j-94v9) — _Drizzle ORM has
SQL injection via improperly escaped SQL identifiers_, **high**, affecting `<0.45.2`. The
repository pinned `^0.44.5`, so the CI job `pnpm audit --prod --audit-level=high` would have
failed on its first run.

This is not a peripheral dependency. Drizzle is the seam every tenant predicate in this
codebase is expressed through, and ADR-0001 layer 3's whole argument is that a statement
without an `organization_id` predicate must be impossible to issue by accident — an
identifier-escaping defect in the layer below that is precisely the wrong place for one.

`drizzle-orm` was moved to `^0.45.2` and the full chain re-run: **211 unit and 300 database
tests still pass, 20 skipped, all six gates exit 0**, and the gating audit now reports no
known vulnerabilities. The bump is a version change only — no repository, guard or test was
altered to accommodate it.

**What is left, and why it is not being fixed.** `pnpm audit --audit-level=low` still reports
one **moderate**: `esbuild <=0.24.2`, reached only through
`drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils`. That chain is a
development dependency, `@esbuild-kit/*` is deprecated upstream and pins its own esbuild, and
the advisory concerns esbuild's **development server**, which this project never starts. CI
already treats the full audit as informational and the production audit as gating, which
classifies this correctly. Recorded rather than silenced.

---

## PLAT-003 — CI gates

Written this session. **The workflow has never run.** This machine has no Docker, no
container runtime, no WSL and no local MySQL or MariaDB (ADR-0002), so the containerised
stack cannot be started here and no result below is presented as a containerised run.

What is claimed is narrower and, hopefully, exactly true: the workflow is written, every
part of it that can be checked without a runner has been checked, and the two claims it
exists to discharge are now instrumented so that a CI run which fails to discharge them
fails loudly instead of passing.

### What the workflow does

`.github/workflows/ci.yml` — three jobs, on push, pull request, a weekly schedule (advisory
data changes without the code changing), and manual dispatch.

| Job        | Contents                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `static`   | `format:check` → `typecheck` → `lint` → `test` → `audit:design`, then `git diff --exit-code` on the regenerated design audit                     |
| `database` | `docker compose up --wait` on the committed stack → MinIO bucket bootstrap with its exit status checked → `db:migrate` → `db:grants` → `test:db` |
| `security` | gitleaks over full history → `pnpm audit --prod --audit-level=high` (gating) → full audit (informational) → no tracked `.env` files              |

The `database` job runs `compose.yaml` itself rather than re-declaring the services as a
GitHub `services:` block. A CI-only copy of the stack would drift from the file developers
run, and the point of the job is that the committed stack works.

### The two claims this converts, and how failure is made loud

Both previously rested on a pipeline that did not exist.

**MariaDB fidelity.** `startTestDatabase` gained a second path: `TMANAGE_TEST_DATABASE_URL`
points the database suite at an external server, and the embedded MySQL remains the default
so local runs are unchanged. Every suite now reports its engine
(`[isolation corpus] engine=mysql 8.0.45 · server=embedded · runtime credential=admin`), and
with `CI` set the corpus **fails** unless it is on the containerised MariaDB.

**ADR-0001 layer 2.** `TMANAGE_TEST_APP_DATABASE_URL` supplies the least-privilege
`tmanage_app` credential, and when it is present the guarded pool uses it — so the whole
44-case isolation corpus re-runs as the application actually runs, rather than as root.
`test/least-privilege.db.test.ts` adds 20 cases for what that credential **cannot** do:

- cannot `UPDATE`, `DELETE` or `TRUNCATE` `audit_events` — and the assertion is on the error
  _code_ (`ER_TABLEACCESS_DENIED_ERROR`), with an explicit check that the trigger's
  `append-only` message does **not** appear. Matching only `/denied/i` would pass on the
  trigger and prove nothing about the grant, which is the whole point of layer 2 being a
  separate layer.
- cannot `ALTER`, `DROP`, `CREATE TABLE`, `CREATE INDEX`, `CREATE TRIGGER` or `CREATE VIEW`
- cannot drop `fk_work_items_project_tenant` — the most direct attack on layer 1
- cannot append to or rewrite `schema_migrations`
- cannot `GRANT`, cannot `CREATE USER`, cannot read `mysql.user`
- cannot reach a second database on the same server (50-BOOTSTRAP §4 puts every environment
  on one server, so this is what separates staging data from production data)
- **can** still do ordinary DML and still holds `STRICT_ALL_TABLES` and UTC — a credential
  locked down until the application stops working is an outage, not a control

Those 20 skip locally and would skip silently in CI too, so a 21st case that never skips
fails the build when `CI` is set and the credential is absent. Both guards were confirmed
to fail here under `CI=1`.

### Migration-order and grant defects, found without a server

`scripts/db/users.sql` had never been executed anywhere. Three defects were found by
reading it against the schema and the compose file — see items 1–3 under "Defects found by
these gates" above. All three are fixed at the root, and the third made the grants stricter
rather than the claim weaker.

`src/common/database/users-sql.test.ts` (12 unit tests, no database required) now holds the
two files together: every granted table must exist in the migrations, every migrated table
must be either granted on or listed as deliberately withheld with a reason, no write
privilege may be granted database-wide, `audit_events` must have `INSERT` without `UPDATE`
or `DELETE`, `schema_migrations` must be `SELECT`-only, the worker must hold no `DELETE`
anywhere, and no file in the repository may mount `users.sql` into a container init
directory again.

`pnpm db:grants` applies the file through the migrator's own tested statement splitter
rather than piping it into a `mysql` client — one SQL-parsing code path, and no dependency
on a client binary. The splitter's output over `users.sql` was inspected here: **25
statements**, comments stripped, all well-formed.

### Secret and dependency scanning

`.gitleaks.toml` extends the default ruleset rather than replacing it, adds one rule for a
committed provider connection string (50-BOOTSTRAP §9), and allowlists exactly one thing:
the literal `local_dev_only_` prefix that every committed credential in this repository
carries. The allowlist is anchored to that prefix rather than to the files containing it,
so a real secret added to `compose.yaml` still fails the scan — a path exclusion would have
stopped scanning those files entirely.

### Named residuals — carried deliberately, not overlooked

1. **`ghcr.io/gitleaks/gitleaks:latest` is a mutable tag.** It must be pinned to a digest
   before this counts as a release gate. It is not pinned now because the digest cannot be
   resolved from this machine and inventing one would fail the first run. Recorded in the
   workflow at the step itself as well as here.
2. **Actions are pinned to major tags** (`actions/checkout@v4`, `pnpm/action-setup@v4`),
   not to commit SHAs. Same reason, same remedy, same first-CI-run task.
3. **Artifact signing** is listed in PLAT-003's scope and is **not** implemented. There is
   nothing yet to sign — no container image, no published package, no release artifact. It
   is deferred to the ticket that produces the first one rather than stubbed.
4. **The worker credential (`tmanage_worker`) is created but not exercised.** The
   least-privilege suite covers `tmanage_app` only; the worker's grants are asserted
   statically by the unit tests. Closing this needs the relay from PLAT-004, which is not
   written.
5. **No branch protection is configured.** PLAT-003's evidence column in `28-SPRINT-TICKETS`
   reads "protected workflow"; a workflow that a push can bypass is not one. That is a
   repository setting, not a file, and needs the owner.

---

## The access layer — Drizzle, and how it was prevented from becoming an escape hatch

Built after PLAT-003, in the same session. `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md`
§6 mandates "Drizzle ORM with the `mysql2` driver, schema-owned repositories, and explicit
SQL migrations".

### The decision that mattered

The obvious wiring — `drizzle(pool, { schema })` — hands the ORM a driver handle and lets it
execute whatever it builds. **Every statement issued that way bypasses `assertTenantScoped`,
and ADR-0001 layer 3 would have been silently dead**: still in the repository, still passing
its 45 unit tests, and no longer on the path of a single production query. That is worse
than never having written the guard, because the tests and this document would both have
gone on saying it was there.

So Drizzle is given a `RemoteCallback` (`drizzle-orm/mysql-proxy`) instead of a driver. It
builds SQL and parameters; the callback hands them to the existing `TenantQueryRunner`,
which runs the guard first and only then touches the connection the transaction is bound to.
Drizzle never holds a pool, a connection, or a credential.

`test/projects-repository.db.test.ts` verifies this rather than assuming it: a deliberately
unscoped Drizzle `select()` must still throw `no organization_id predicate`, still emit a
guard event naming `projects`, and the test then replays the rejected statement on the admin
connection to show it would have returned three tenants' rows.

### Defects found by building it

5. **The proxy callback contract is not what its type suggests.** For a non-select, Drizzle
   reads `rows[0].insertId` and `rows[0].affectedRows` — the `ResultSetHeader` belongs
   _inside_ the `rows` array, not in the top-level `insertId`/`affectedRows` fields the
   callback's return type also offers. Populating only the documented-looking fields fails
   with `Cannot read properties of undefined (reading 'insertId')` on every insert.
6. **The proxy dialect decodes text-protocol values.** `datetime` columns decode with
   `value.replace(' ', 'T') + 'Z'`, so they require a string; mysql2 is configured with
   `dateStrings: false` and returns a `Date`. Converted at the seam rather than by setting
   `dateStrings: true` on the pool — that flag is global, and the isolation corpus, the
   migrator and the seed fixtures all read `DATETIME(3)` as `Date` through the same pool.
7. **Drizzle's error wrapper leaks bound parameters.** It wraps anything thrown during
   execution in a `DrizzleQueryError` whose message is `Failed query: <sql>\nparams: <params>`.
   Two consequences, the second worse than the first: the tenant guard's refusal and a
   composite-foreign-key violation both reach callers as a generic "Failed query",
   indistinguishable from a connection reset — and the message now carries the parameter
   values into whatever logs it. Every other diagnostic in this layer is careful not to; the
   guard emits a redacted statement _shape_ and the corpus asserts it contains no tenant
   data. `query-error.ts` unwraps at `TenantDatabase.transaction()`/`read()`, the one
   boundary every repository call returns through.

### The schema is described, not defined — and the drift is tested

`schema.ts` describes the tables; `migrations/*.sql` create them. That is the reverse of the
usual Drizzle workflow and is deliberate: a generated migration cannot express composite
tenant foreign keys, the `organization_id` immutability triggers, or the append-only
triggers on `audit_events` — it would silently omit exactly the parts tenant isolation
depends on — and DATA-001's ledger assumes reviewed, checksummed SQL.

The cost is two descriptions of one schema, free to drift. `test/schema.db.test.ts` pays it:
44 cases reading `information_schema` from a migrated database, comparing the table set,
every column name, every nullability flag, and every column type. Mutation-tested — renaming
a column, flipping one `notNull`, and widening one type produced 3 failures naming each.

A drifted `notNull` is not cosmetic: it makes TypeScript promise a value the database does
not, with no error anywhere.

---

## The membership resolver — the one read that cannot be tenant-scoped

Built this session, and the reason it is written up separately from the repositories is that
it is the only place in the application that **waives ADR-0001 layer 3**.

Spec §3 has a bootstrapping problem in the middle of it: step 2 "resolves the requested
organization against an active internal or client membership", and step 3 builds the
`TenantContext`. The resolving read cannot itself carry `WHERE organization_id = ?` bound to
the active context, because there is no active context — and binding it to the organization
the _request_ asked for would check the request against itself and prove nothing.

### The hole, and the three constraints that measure it

`TenantDatabase.bootstrapRead()` is the escape. It is the same audited `unscoped` hatch the
outbox relay uses, plus two limits the relay does not have:

| Constraint                   | What it refuses                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mandatory audited reason     | Same as the relay. Every statement emits a guard event carrying `allowedReason`.                                                                                                                                    |
| **Read-only**                | `select` and `with` only. Establishing which tenant a session belongs to is a question, not a change — so organization provisioning cannot reach for this path                                                      |
| **Declared table allowlist** | Anything outside `organizations`, `memberships`, `client_memberships`. Without it, "unscoped" would mean every row in the database, and the resolver would be a more powerful primitive than anything it bootstraps |

The allowlist counts **every tenant-table name that survives tokenization**, not the tables
the guard's analyser managed to place. That distinction is load-bearing and is tested: a
statement the analyser cannot parse is exactly the statement that must not slip past the
check that exists _because_ the tenant predicate has been waived.

### What the resolver refuses

24 database cases. Nothing resolves for: another organization's member, a suspended,
invited or offboarded membership, an expired client membership, an archived organization, a
role the capability table does not know, a **client membership carrying an internal role**
(the escalation one bad row would otherwise buy), an internal membership carrying a client
role, or a person holding both an internal and a client membership in the same tenant.

That last one refuses rather than picking. Preferring internal escalates whoever was added
to the wrong table; preferring client demotes staff. Neither failure announces itself.

Every refusal carries **the same message**. The specific cause travels in a `code` property
for the audit event and never reaches the caller: an outsider who can distinguish "no such
organization" from "you are not in it" can enumerate the customer base one slug at a time,
and slugs are company names. A test asserts an unknown slug and a real-but-unreachable one
produce byte-identical answers.

### And the escape stops there

`PrincipalRepository` loads the project relation set on the **ordinary guarded path**, after
the context exists — `project_memberships` for internal principals, `project_clients`
filtered by their own client organization for external ones. A test asserts that assembling
a principal emits **no** guard event at all, which is what keeps the waiver one read rather
than a mode the request stays in.

### The new guards were verified to fire, not merely to pass

Seven mutations, each reverted, each file then confirmed byte-identical by SHA-256:

| Mutation                                                        | Result                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------- |
| Bootstrap read-only check disabled                              | **1 failure** — the bootstrap write case                  |
| Allowlist built from the analyser's understood tables instead   | **1 failure** — the unplaceable-table case                |
| Ambiguity check removed                                         | **1 failure**                                             |
| Role-kind check weakened to "is it any known role"              | **2 failures** — both escalation directions               |
| `status = 'active'` and the archived-organization check removed | **4 failures** — suspended, invited, offboarded, archived |
| `offboarded` made reversible                                    | **1 failure** — the terminal-state case                   |
| Client project scope loses its client-organization filter       | **1 failure** — the client-to-client boundary             |

The Drizzle row-mapping defect above was found the same way, except that it was found by a
test written before the code rather than by a deliberate mutation.

---

## ID-001 — sessions, refresh rotation, and reuse detection

Built this session. This is spec §3 **step 1**, the step the membership resolver deliberately
starts _after_: `MembershipResolver.resolve()` takes a `userId` that "authentication has
already established", and until now nothing established it. `sessions` existed in the schema
and no code read it.

### The schema could not detect reuse, and that was the whole ticket

`04-SECURITY-PRIVACY` §3 asks for "short-lived access session plus rotating refresh token;
refresh reuse detection and device/session list". Three of the four were reachable with
`sessions` as `0001_tenancy.sql` created it. The fourth was not, and the reason is worth
stating because it is not obvious:

`sessions` holds **one** refresh-token hash. Rotation can be done with that alone — overwrite
the hash — but a stolen token that has already been rotated away then hashes to a value the
table no longer holds. Replaying it is indistinguishable from replaying random noise. The one
signal that matters is destroyed at exactly the moment it fires.

So `0003_session_rotation.sql` adds:

| Change                              | Why                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_refresh_tokens` (table)    | An append-only ledger of hashes that **used to be** live. A presented token is live, superseded, or unknown — three answers, one lookup each        |
| `sessions.rotated_at`               | When the current token was issued. Feeds the device list and dates the superseded row                                                               |
| `sessions.revoked_reason`           | Why a session ended. Carries `refresh_reuse_detected`, which is a security finding rather than a lifecycle event                                    |
| Two triggers on the new table       | UPDATE and DELETE rejected for **every** credential. An attacker who could delete their replayed hash would make a compromise look like a stale tab |
| One grant in `scripts/db/users.sql` | `INSERT` only, matching `audit_events`. The runtime user may append evidence and can never amend it                                                 |

`sessions.refresh_token_hash` keeps its meaning and its unique key. The live column and the
ledger are **disjoint by construction** — a hash is either current or superseded, never both —
so there is no denormalised copy free to drift.

### What is deliberately absolute

`sessions.expires_at` is fixed at sign-in and is **not extended by rotation**. A refresh token
that slides its own expiry produces a session that never ends, and a stolen one that never
ends either. The access token's expiry is additionally clamped to it, so a session in its last
minute cannot hand out a fifteen-minute access token.

### Every request reads the session row

`authenticate()` verifies the access token's HMAC and then loads the row. The second half is
not redundant: 04 §3 requires "immediate server-side revocation on offboarding", and a token
trusted on its signature alone stays valid until it expires — "immediate" would silently mean
"within `SESSION_TTL_SECONDS`". The signature's job is narrower and still worth having: a
forgery is rejected before it costs a connection, and a client cannot nominate a session id of
its own, which is what session fixation is.

Symmetrically, the refresh token is **opaque** — 256 random bits, stored only as SHA-256, never
signed and never parsed. It is only ever looked up. Signing it would add a check that cannot
fail independently of the lookup, and give an attacker structure to read.

### A new database path, and why it is not a second escape hatch

Step 1 runs before step 2, so there is no `TenantContext` — and, unlike the membership
resolver's bootstrap read, there is nothing to waive:

|                         | `bootstrapRead` (TEN-001) | `identityRead` / `identityTransaction` (ID-001) |
| ----------------------- | ------------------------- | ----------------------------------------------- |
| Tenant tables reachable | three, declared           | **none**                                        |
| Writes                  | refused                   | permitted                                       |
| ADR-0001 layer 3        | **waived**, audited       | **fully in force**                              |

The guard runs in ordinary `enforce` mode against the nil organization id, so a statement
reaching a tenant table cannot bind a predicate to it and is rejected exactly as any unscoped
statement would be. On top of that, an explicit check refuses any statement mentioning a
tenant table **before** the guard runs and **regardless of guard mode** — `TENANT_GUARD_MODE=observe`
is set for a documented incident and must not turn the pre-authentication path into a route to
every tenant's rows. A test asserts a whole sign-in → authenticate → refresh → revoke cycle
emits **no guard event at all**.

`NON_TENANT_TABLES` stopped being documentation and became load-bearing: a table must be
registered there before the identity path may be declared over it, and a new corpus case reads
`information_schema` and fails if any table in the database is in neither registry.

### One message for every refusal

The same rule the membership resolver follows. "No such session", "revoked", "expired" and
"replayed" are four audit entries and one caller-facing answer; the cause travels in `code`.
Tested: a missing cookie, a malformed one and a revoked session produce **one** message and
**three** codes.

### The cost of strict reuse detection, recorded rather than smoothed over

Two browser tabs refreshing at the same instant is **not** reuse — the compare-and-swap on the
live hash means exactly one wins and the other is told it lost. But a client that retries a
refresh whose response it never received **is** indistinguishable from a replay and will lose
its session. The usual mitigation is a short grace window accepting the immediately-previous
token; that weakens the detector by exactly the width of the window, and the width is a product
decision the pack does not make. Left out rather than invented — listed under the open gaps.

### The new guards were verified to fire, not merely to pass

Twelve mutations, each run against the suite, each reverted, and all eight touched files then
confirmed byte-identical to their pre-mutation SHA-256. (The Prettier pass that followed
changed whitespace in three of them; the full gate chain was re-run after it.)

| Mutation                                                     | Result                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Identity path's tenant-table check removed                   | **4 failures** — including the observe-mode case, which the guard alone misses |
| Identity allowlist widened to "any known table"              | **1 failure** — the `projects` declaration                                     |
| Superseded hash not recorded on rotation                     | **9 failures** — the ledger is what detection rests on                         |
| Replay refused but the session left live                     | **2 failures**                                                                 |
| Reuse throw moved _inside_ the transaction                   | **2 failures** — fails exactly at the committed-revocation assertion           |
| Compare-and-swap on the live hash removed                    | **1 failure** — two rotations from one token                                   |
| Revocation made non-idempotent                               | **1 failure** — a sign-out overwriting the reuse finding                       |
| Access-token clamp to the session deadline removed           | **1 failure**                                                                  |
| Expiry checked before the signature                          | **1 failure** (unit)                                                           |
| Both append-only triggers removed from the migration         | **2 failures**                                                                 |
| `session_refresh_tokens` unregistered in `NON_TENANT_TABLES` | **1 failure** — the new classification case                                    |
| The grant on the new table omitted from `users.sql`          | **1 failure** (unit) — "neither granted nor deliberately withheld"             |

### Named gaps in ID-001, carried deliberately

1. **Nothing authenticates a person.** `start()` takes a `userId` that something else has
   already proved. Passwords, passkeys, MFA and SSO are ID-002 and are not written. The
   signature says so rather than implying a check that does not exist.
2. **No CSRF token.** 04 §3 requires CSRF protection for state-changing requests and
   `CSRF_SECRET` is already configured, but a double-submit token needs a request to attach to
   and a header to compare against. It belongs with the HTTP surface.
3. **No refresh grace window** — see above. Strict detection is the secure default and the
   consequence is real.
4. **No `__Host-` cookie prefix.** It requires `Path=/` and no `Domain`, which the path-scoped
   refresh cookie cannot satisfy, and applying it to only one of the pair invites the belief
   that both are protected. Closing it needs the deployment-domain decision and a change to
   `SESSION_COOKIE_NAME`.
5. **No audit events are written.** Reuse detection, revocation and the global cutoff are all
   §12 audit-required, and AUD-001 has no service yet. The causes are carried on the error's
   `code` and on `revoked_reason` so that the eventual audit writer has something exact to
   record — but nothing records it today.
6. **`sessions` has no retention or purge.** Revoked and expired rows accumulate, and the
   ledger's append-only triggers mean a purge is a privileged, separately-credentialed
   procedure — the same position `audit_events` is in.
7. **The new grant has never run against a server.** Same status as the rest of ADR-0001
   layer 2: held to the schema by the static assertions, waiting on CI for an execution.

**Gap 2 is now closed.** CSRF landed with the HTTP surface — see the next section and
ADR-0004. Gaps 1 and 3 to 7 remain open and are restated at the end of that section.

---

## The HTTP surface — `25-AUTH-AND-TENANT-ISOLATION` §3, end to end

Built across the previous session and this one. NestJS 11 on Fastify. This is the layer that
turns the pieces below it into a request: the first four steps of §3 were already callable,
and this is what calls them, in order, for every route by default.

### The pipeline is the policy, in registration order

Nest applies global guards in the order they are registered, so the provider array in
`app.module.ts` **is** the sequence. It is one readable list rather than a set of annotations
scattered across controllers:

| #   | Guard                | §3 step | Refuses                                                   |
| --- | -------------------- | ------- | --------------------------------------------------------- |
| 1   | `SessionAuthGuard`   | 1       | no / forged / revoked / expired session → **401**         |
| 2   | `CsrfGuard`          | 04 §3   | unsafe method without a session-bound token → **403**     |
| 3   | `TenantContextGuard` | 2–4     | no active membership for the named organization → **404** |
| 4   | `CapabilityGuard`    | 5       | capability outside the role ceiling → **403**             |

Two orderings are load-bearing rather than tidy. CSRF must follow authentication, because the
token is bound to a session id and there is nothing to bind against until step 1 has run. The
capability check must follow the tenant context, because a capability is meaningless without a
principal, and a principal exists only once a membership has proved which organization the
request is in.

They are registered **globally**, so the default for a new route is the whole sequence.
Opting out is an explicit `@Public()` or `@NoTenant()` — a visible line in a diff — rather
than the silent consequence of forgetting an annotation. A tenant-scoped route that reached
`CapabilityGuard` with no `@RequireCapability` is **refused**, not allowed: a route whose
author did not say what it needs is not a route that needs nothing.

### Status mapping chosen so that a refusal cannot enumerate

This is the part with security content, and each choice is a decision rather than a default:

- **401 — one message for every authentication failure.** `SessionNotAuthenticatedError`
  distinguishes eight causes (`no_cookie`, `bad_signature`, `session_revoked`,
  `session_expired`, …). All eight render identically. The cause travels to the log on
  `auditCode`.
- **404, not 403, when a membership does not resolve.** A 403 would confirm the organization
  exists. Slugs are company names and therefore guessable, so that would be a
  customer-enumeration oracle for anyone holding any valid session. The response to a
  real-but-unreachable slug is asserted **byte-identical** to the response for a slug that
  does not exist.
- **403 generic for a capability denial.** The precise `DenialCode` stays server-side; each
  value describes a fact about something the caller has just been told they cannot see.
- **500 with the text dropped for the three isolation violations.** `TenantGuardViolation`,
  `BootstrapScopeViolation` and `IdentityScopeViolation` mean a statement tried to reach data
  without a tenant predicate — a defect in this application, not a bad request. Rendering one
  as 4xx would file the most serious class of bug here under "the client did something wrong".

### CSRF — ADR-0004

Token is `HMAC(CSRF_SECRET, sessionId)`, issued in the one readable cookie
(`serializeReadableCookie`) and echoed in `X-CSRF-Token`. Binding it to the session id is what
defeats cookie tossing, which plain double-submit does not survive: an attacker who controls a
sibling subdomain can plant a cookie whose value they know, but cannot plant the victim's
session cookie.

The refresh route is the one seam. It carries no access cookie, so its session id is unknown
until the refresh token has been looked up; verification therefore happens **inside**
`SessionService.refresh()`, after resolution and before rotation commits. A CSRF failure there
returns the same generic message as every other refresh failure and leaves the session usable
— both asserted.

### The dev sign-in route is absent in production, not present-and-refusing

`POST /v1/dev/sessions` exists because ID-002 is not written and nothing yet authenticates a
person. When `allowDevelopmentSignIn` is false the route is **not registered at all**: the
module that carries it is never imported. A route that exists and refuses is one bad
conditional away from a route that exists and accepts. A test boots a second application under
a production configuration and asserts 404.

### Three defects, found by the suite and fixed at the root

Recorded because in each case the tempting fix was the wrong one:

1. **Every guarded route returned 500.** Request state was created in an interceptor, and
   **guards run before interceptors in Nest** — so the state no guard could find did not
   exist. Fixed by creating it lazily on first touch (`ensureRequestState`), so ordering
   cannot matter, rather than by reordering two things that would drift apart again.
2. **`CapabilityGuard` denied every client principal.** It called `authorize()` with a
   synthetic organization-level resource at audience `internal`, and `authorize()` correctly
   denies any client principal reading an `internal` resource — so clients 403'd at the guard
   before the service could make the real, object-level decision. Fixed by making the guard an
   honest role-ceiling check with **no object**. The object-level decision belongs in the
   service, with a `ResourceContext` built from the loaded row.
3. **The composition root named a `mysql2` Pool.** ADR-0001 layer 4's lint boundary rejected
   it, correctly. Fixed by moving pool construction into `DatabaseModule` (`forUrl` /
   `forPool`) rather than by widening the allowlist. A composition root that cannot name a
   connection pool cannot accidentally hand one to a controller.

### Why every injected parameter carries a token — ADR-0003

`@Inject(TOKEN)` on every constructor parameter, no exceptions. vitest transforms TypeScript
with esbuild, which does not implement `emitDecoratorMetadata`, and the failure mode is worse
than a wiring error: without `design:paramtypes` Nest sees a **zero-argument constructor**, so
the container reports nothing, the application starts cleanly, every route registers, a health
check passes, and every real request 500s. `nest-di.test.ts` asserts both directions — the
tokenised graph serves 200, and the metadata graph starts silently and returns 500 — so the
constraint is held by a test rather than by a paragraph.

### The new guards were verified to fire, not merely to pass

Eight mutations, each run against the suite, each **killed by a named test**, each reverted,
and each file then confirmed byte-identical to its pre-mutation SHA-256.

| Mutation                                                            | Named test that failed                                                   | Observed                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------- |
| `POST` added to the CSRF safe-method allowlist                      | "refuses a mutation with no CSRF header"                                 | expected 201 to be 403                          |
| CSRF token compared on its first three characters only              | "refuses a CSRF token bound to a different session"                      | expected 201 to be 403                          |
| Session trusted on its signature alone (revocation column not read) | "signs out, clears all three cookies, and kills the session immediately" | expected 200 to be 401                          |
| Tenant taken from an `X-Organization-Id` header when present        | "ignores a caller-supplied organization header"                          | project list came back empty                    |
| `CapabilityGuard.canActivate` returns `true` unconditionally        | "refuses a client reviewer the capability to create a project"           | expected 201 to be 403                          |
| `auditCode` serialised into the error envelope                      | "never returns the denial reason to the caller"                          | body contained `capability_not_in_role_ceiling` |
| Membership refusal changed from 404 to 403                          | "refuses an organization the caller has no membership in"                | expected 403 to be 404                          |
| Dev sign-in route registered unconditionally                        | "is not registered at all under a production configuration"              | expected 201 to be 404                          |

Two of these needed a test that did not exist, and it was written rather than the mutation
softened. `ignores a caller-supplied organization header` sends four plausible spellings of a
tenant header naming an organization the caller genuinely cannot reach, and asserts the
response is **byte-identical** to the same request without them — a header that shifted the
tenant would most likely show up as a different row set rather than a different status.

One check was run against a hypothesis and the hypothesis was wrong, which is worth recording:
the 404 → 403 mutation was expected to survive the byte-parity case (both refusals would
become 403, and 403 == 403). It did not — that case carries its own explicit
`toBe(404)` assertions alongside the byte comparison, so it kills the mutation on its own.

### Named gaps in the HTTP surface, carried deliberately

1. **Nothing authenticates a person.** Unchanged from ID-001 gap 1. `POST /v1/dev/sessions`
   takes a `userId` and is absent outside development. ID-002 is not written.
2. **No refresh grace window.** Unchanged from ID-001 gap 3: a grace window weakens the reuse
   detector by exactly its own width, and the width is a product decision the pack does not
   make.
3. **No `__Host-` cookie prefix.** Unchanged from ID-001 gap 4; it needs the
   deployment-domain decision. ADR-0004 records it against the CSRF cookie specifically.
4. **No audit events are written.** Every refusal above carries an exact `auditCode`, and
   nothing consumes it. AUD-001 has no service.
5. **The CORS policy is configured but never exercised.** `main.ts` sets an exact origin
   list, `credentials: true`, and allows `X-CSRF-Token` explicitly — but `main.ts` is the
   bootstrap, not part of `AppModule`, so the pipeline suite (which builds `AppModule`
   directly) never runs it. ADR-0004's argument that a cross-origin request carrying a custom
   header is preflighted and then refused is therefore **reasoned, not observed**. The CSRF
   token check does not depend on it; the second layer of SEC-03 does.
6. **No rate limiting on the session routes.** `rate_limited` is in the error vocabulary and
   nothing produces it.

---

## PROJ-001 — the four remaining repositories

Written this session, following `ProjectsRepository` exactly rather than each finding its own
shape: `TenantContext` as the first parameter, **no `organizationId` on any input type**,
keyset pagination on `(organization_id, id)`, optimistic concurrency, and _not-found_ rather
than conflict for a caller in the wrong tenant. All four tables already existed in
`0001_tenancy.sql`; **no migration was written and none was needed**.

| Repository                      | File                                                     | Concurrency token          |
| ------------------------------- | -------------------------------------------------------- | -------------------------- |
| `ClientOrganizationsRepository` | `src/modules/clients/client-organizations.repository.ts` | `updated_at`               |
| `ClientMembershipsRepository`   | `src/modules/clients/client-memberships.repository.ts`   | `updated_at`               |
| `ProjectMembershipsRepository`  | `src/modules/projects/project-memberships.repository.ts` | compare-and-swap on `role` |
| `WorkItemsRepository`           | `src/modules/work/work-items.repository.ts`              | real `version` column      |

The token differs per table because the **tables** differ, not because the house style does.
`work_items` has a `version` column and uses it; `projects`, `client_organizations` and
`client_memberships` do not and use `updated_at`; `project_memberships` has neither, and the
strongest token it can offer is the role the caller believed was current.

Covered by `test/proj-001-repositories.db.test.ts` — **49 cases, all executed** against the
embedded MySQL 8.0.45 and the adversarial Northstar Studio / Northstar Studios pair. One file
rather than four: `fileParallelism` is off and each database file starts its own server, so a
fourth file would have cost roughly another minute of wall clock to prove nothing a shared
world cannot.

Four things the suite asserts that are worth naming, because they are the ones a reviewer
would otherwise have to take on trust:

- **Expiry is decided by the database, not by JavaScript.** A client grant that is still
  `status = 'active'` but past `expires_at` is excluded from the default list and included
  only under `includeExpired`. `isActiveNow()` is the in-hand equivalent for a row already
  loaded, and the suite checks the two agree.
- **`offboarded` is terminal.** Moving a client membership back to `active` is refused, and
  the row is verified unchanged afterwards. Re-admitting someone is a new membership.
- **Archiving a client organization does not revoke its members' access.** The repository
  offers no cascade, and the test proves the members are still active afterwards. Ending a
  client relationship is two acts, and the second is per named person.
- **Soft deletion is not the `archived` state.** An archived work item is still listed; a
  soft-deleted one is not, and deletion leaves the lifecycle state alone.

### Two things found while writing these, recorded rather than fixed

1. **`work_items.state` defaults to `'triage'`, which is not a work-item state.**
   `0001_tenancy.sql:254` and `schema.ts:294` both carry `DEFAULT 'triage'`, but `triage`
   belongs to the **client-request** lifecycle (`23-ERD` §7). `23-ERD` §5 gives `backlog` as
   the work-item initial state. Nothing depends on the default today — the seed writes the
   column explicitly, and `create()` writes `workItemStateMachine.definition.initial` rather
   than letting the column decide — so the defect is latent, not active, and a test asserts
   the created row is `backlog`. **Correcting the default is a migration**, which this task
   explicitly scoped out, so it is left here for a decision rather than changed quietly.
2. **Removing a project membership is a real `DELETE`, and nothing records that it happened.**
   Everywhere else removal is a state, because audit events reference the row. A project
   membership is a _grant_, not a record of something that happened: nothing references it,
   and a soft-deleted grant is one forgotten `WHERE deleted_at IS NULL` away from being live
   again. That trade only holds if the revocation is recorded elsewhere — and today it is
   not, because AUD-001 has no service. `remove()` returns a boolean precisely so the command
   that will write that event knows whether anything was revoked. **This is a gap, not a
   design.**

---

## Sprint 0 (`28-SPRINT-TICKETS` §3)

| Ticket    | Scope                                              | Status        | Evidence                                                                                                                                                                                                                                     |
| --------- | -------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PLAT-001  | pnpm monorepo, shared config, ownership boundaries | `implemented` | Workspace builds; boundary rules encoded as lint errors in `eslint.config.js`, and the `db` boundary is proven to fire                                                                                                                       |
| PLAT-002  | one-command local stack                            | `implemented` | `compose.yaml` (MariaDB 11.4 · Valkey 8.1 · MinIO). One defect fixed this session (the `users.sql` init-mount could never have succeeded). **Still never started** — no container runtime here; the CI `database` job is what will verify it |
| PLAT-003  | CI gates, secret/dependency scans                  | `implemented` | `.github/workflows/ci.yml` + `.gitleaks.toml` + `db:grants` + the least-privilege suite. **Not `tested`: the workflow has never run.** Artifact signing deferred (nothing to sign yet); branch protection is an owner action                 |
| OBS-001   | OpenTelemetry correlation + log redaction          | `not_started` | —                                                                                                                                                                                                                                            |
| DATA-001  | migration framework, UUIDv7, app/migration users   | `tested`      | Migrator: 15 database tests + 9 splitter tests. **Exception:** `scripts/db/users.sql` is now covered by 12 static assertions and by a CI suite that has not run; it has still never been executed against a server                           |
| AUTHZ-001 | tenant context + isolation foundation              | `tested`      | 44-case isolation corpus against real MySQL + 45 guard-analyser unit tests + 29 evaluator tests. Under the **admin** credential; the least-privilege re-run is pending CI                                                                    |
| PLAT-004  | transactional outbox + idempotency                 | `implemented` | Tables, append-only audit, per-tenant idempotency uniqueness and the relay escape hatch are tested. The relay/dispatcher itself is **not written**                                                                                           |
| UI-001    | tokens, primitives, Storybook, visual harness      | `not_started` | Design tokens available at `docs/design/source/project/design/tokens/`                                                                                                                                                                       |

## Sprint 1 (`28-SPRINT-TICKETS` §4)

| Ticket   | Scope                                          | Status        | Evidence                                                                                                                                                                                                                                                                                                                                                                |
| -------- | ---------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ID-001   | session cookie, refresh rotation/reuse         | `tested`      | 43 database cases + 27 unit cases, now driven through real HTTP as well. Session cookie, rotation, reuse detection, global cutoff, device list, and **CSRF (gap 2 closed — ADR-0004)**. Twenty mutations across two sessions confirm the guards fire. **Nothing authenticates a person yet** — sign-in takes an already-proved `userId` (ID-002); six named gaps remain |
| TEN-001  | organization/workspace/membership aggregates   | `tested`      | 21 database cases. Organizations, workspaces and memberships, plus the membership resolver's 24 cases. **Exception:** organization _creation_ is not written — see below                                                                                                                                                                                                |
| TEN-002  | roles/capabilities and policy evaluator        | `tested`      | The evaluator itself was already tested (29 cases, `packages/domain`). This session wired it: `PrincipalRepository` assembles a `Principal` from a resolved membership plus a scoped project-relation read                                                                                                                                                              |
| TEN-003  | invitation issue/accept/revoke/expiry          | `implemented` | The storage half only: `invite()` writes an `invited` row that authorises nothing, and `transitionStatus()` accepts it. Still no invitation token, no email, no expiry job. ID-001 has landed, so the remaining blockers are the notification surface and a single-use hashed token table of its own                                                                    |
| AUD-001  | append-only audit service/view model           | `not_started` | The table and its triggers are tested; no service writes to it yet                                                                                                                                                                                                                                                                                                      |
| WEB-001  | identity/onboarding screens                    | `not_started` | Depends on UI-001 and contracts                                                                                                                                                                                                                                                                                                                                         |
| TEST-001 | tenant/role matrix harness and two-tenant seed | `implemented` | The seed world and the adversarial pair are exercised by every database run. The **role** half of the §11 matrix — every role against every grid column — is not yet a generated harness                                                                                                                                                                                |

### Named gaps in TEN-001/TEN-002, carried deliberately

1. **Organization creation is not implemented.** Provisioning happens before any membership
   exists, so it cannot run under a `TenantContext`, and the bootstrap path is read-only by
   construction. It needs ID-001's verified session and a founding-owner membership in one
   transaction. Recorded rather than half-built.
2. **Slug changes are not implemented.** The slug is in every bookmarked URL and every link
   already sent to a client. Whether the old slug is reserved or reusable is a product
   question the pack does not answer, and guessing would ship the guess.
3. **A Workspace Admin does not get organization-wide scope by default.**
   `12-PERMISSION-MATRIX` §2 records "Scope" for them, but their scope is one workspace,
   `memberships` has no workspace-scope column, and `Principal.hasOrgWideScope` is a boolean
   with no room for "within these workspaces". The default is therefore the narrower of the
   two readings, and an explicit override exists so an organization that wants otherwise
   records the decision. Closing this properly needs a workspace-scope column and a
   migration.
4. **`policyVersion` is derived, not stored.** No migration defines a policy-version column,
   so it is computed from the organization row's and the membership row's `updated_at`. That
   moves when a role changes, which is the case §11 cares about; it will not move when a
   policy lands in a table that does not exist yet. One function to change when it does.

---

## The MySQL data layer

Built in the previous session; the last two rows and the CI harness were added by PLAT-003.

| File                                          | Role                                                                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/common/database/migrator.ts`             | Ordered `.sql`, `GET_LOCK()` on one dedicated session, SHA-256 checksums, `DELIMITER`-aware splitting, explicit partial-failure handling |
| `src/common/database/connection.ts`           | Runtime pool and migration connection; strict mode, UTC, `utf8mb4`, bounded pool                                                         |
| `migrations/0001_tenancy.sql`                 | ADR-0001 layer 1 — 11 tables, composite tenant FKs, immutability triggers                                                                |
| `migrations/0002_platform_primitives.sql`     | Outbox, idempotency, append-only audit                                                                                                   |
| `src/common/database/tenant-context.ts`       | Immutable `TenantContext`, organization-bound transaction wrapper                                                                        |
| `src/common/database/tenant-guard.ts`         | ADR-0001 layer 3 — the RLS replacement                                                                                                   |
| `eslint.config.js`                            | ADR-0001 layer 4 — the `db` import and raw-SQL boundary (§6)                                                                             |
| `test/seed-two-tenants.ts`                    | The seed world plus §11's adversarial pair                                                                                               |
| `test/tenant-isolation.db.test.ts`            | ADR-0001 layer 5 — the isolation corpus                                                                                                  |
| `scripts/db/users.sql` + `db:grants`          | ADR-0001 layer 2 — least-privilege users, applied after the migrations by the migrator's own splitter                                    |
| `test/least-privilege.db.test.ts`             | ADR-0001 layer 2 under test — 20 cases for what `tmanage_app` cannot do (pending CI)                                                     |
| `src/common/database/users-sql.test.ts`       | The static half of layer 2 — 12 cases holding `users.sql`, the migrations and `compose.yaml` in agreement                                |
| `.github/workflows/ci.yml`                    | PLAT-003 — the gate chain, the containerised MariaDB run, secret and dependency scanning                                                 |
| `src/modules/tenancy/*.repository.ts`         | TEN-001/TEN-002 — the membership resolver and the organization, workspace, membership and principal aggregates                           |
| `migrations/0003_session_rotation.sql`        | ID-001 — the superseded-token ledger and its append-only triggers                                                                        |
| `src/modules/identity/session-token.ts`       | ID-001 — cookie attributes, the signed access token, the opaque refresh token. Pure                                                      |
| `src/modules/identity/sessions.repository.ts` | ID-001 — session storage; the compare-and-swap rotation and the server-clock expiry verdict                                              |
| `src/modules/identity/session.service.ts`     | ID-001 — authentication, rotation, reuse detection, revocation, device list                                                              |

### MySQL DDL is not transactional — how partial failure is handled

`CREATE TABLE`, `ALTER TABLE`, and `CREATE TRIGGER` each cause an implicit commit, so
wrapping a migration in a transaction buys nothing: if statement 7 of 12 fails, the first
six are permanently committed and there is no rollback to issue.

The migrator therefore does not pretend otherwise:

1. A ledger row is committed **before** the first statement, recording the statement count.
2. `statements_applied` is advanced after each statement, also committed.
3. On failure the row becomes `failed`, carrying the failing index and the server's message.
4. **Every later run refuses to do anything** while a `running` or `failed` row exists.
   Resuming automatically would mean guessing whether a statement had landed.

Recovery is a deliberate human action, and the ledger names the exact resume point.
`migrator.db.test.ts` proves all four properties against a real server, including that the
committed prefix survives, that `db:status` reports it without throwing, and that a cleared
ledger row lets the migrator proceed.

### What the isolation corpus actually asserts

Two organizations with **intentionally similar names and adjacent identifiers** (§11):
**Northstar Studio** and **Northstar Studios** — ids differing in the final hex digit only,
identical project and work-item titles, owner emails one character apart. File 19's demo
tenants (Northstar Studio / Atlas Hospitality / BrightOps Consulting) are seeded unchanged
alongside them; the twin is an addition, not a rename, so both documents are satisfied.

That similarity is the point: a corpus seeded with obviously distinct tenants passes even
when the tenant predicate is missing, because the rows do not collide. These do.

Every rejection case also asserts what the rejected statement _would_ have done — the
unscoped read is replayed on the admin connection to show three tenants' rows, including
two projects with the identical name. Coverage: schema invariants read back from
`information_schema`, composite-FK rejection, the immutability trigger under a _full-
privilege_ connection, scoped/unscoped reads, direct-ID enumeration, the adjacent-id case,
same-tenant/different-project, same-tenant/different-client, joins anchored on one side
only, inserts deriving the tenant from a payload, transaction rollback, bulk update and
delete, suspended membership, expired client membership, per-tenant idempotency keys, the
outbox relay's audited escape hatch, append-only audit, guard-event redaction, and
`observe` mode demonstrating the leak it permits.

### A drift check that cannot be forgotten

The corpus reads `information_schema.columns` and fails if any table carrying an
`organization_id` column is absent from the guard's `TENANT_TABLES` registry. A future
module migration cannot add a tenant table that the guard silently ignores.

---

## Component status

| Component                                               | Status        | Notes                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/config`                                       | `tested`      | 25 tests. MySQL schemes, `DEPLOYMENT_PROFILE`, `TENANT_GUARD_MODE`; production refuses dev substitutes and placeholder secrets                                                                                                                                                  |
| `packages/domain` — state machines                      | `tested`      | 35 tests across all 7 lifecycles in `23-ERD` §5–§11                                                                                                                                                                                                                             |
| `packages/domain` — authorization                       | `tested`      | 29 tests over the §11 grid — application layer                                                                                                                                                                                                                                  |
| `packages/domain` — value objects                       | `tested`      | 11 tests. UUIDv7 (incl. >2³² ms), content hash                                                                                                                                                                                                                                  |
| `apps/api` — migrator                                   | `tested`      | 15 database tests, 9 splitter tests                                                                                                                                                                                                                                             |
| `apps/api` — schema (0001, 0002)                        | `tested`      | Applied from empty on every database run; invariants read back from `information_schema`                                                                                                                                                                                        |
| `apps/api` — tenant context + guard                     | `tested`      | 45 analyser tests, 44 corpus tests                                                                                                                                                                                                                                              |
| `apps/api` — least-privilege credentials                | `implemented` | 12 static assertions pass; the 20 dynamic cases require the containerised MariaDB and are **skipped** here                                                                                                                                                                      |
| `apps/api` — Drizzle schema + guarded seam              | `tested`      | 44 drift cases against `information_schema`, mutation-tested; the seam is proven to keep the guard on the query path                                                                                                                                                            |
| `apps/api` — repositories                               | `tested`      | Projects (18 cases), organizations/workspaces/memberships (21), and **client organizations, client memberships, project memberships and work items (49)**. All eight follow one shape; two findings from the last four are recorded under PROJ-001 above                        |
| `apps/api` — membership resolver + bootstrap read       | `tested`      | 24 database cases. The only waiver of ADR-0001 layer 3, bounded by an audited reason, a read-only rule and a table allowlist — all three mutation-tested                                                                                                                        |
| `apps/api` — principal assembly (TEN-002)               | `tested`      | Project relation loaded on the scoped path; a test asserts no guard event is emitted while a principal is assembled                                                                                                                                                             |
| `apps/api` — sessions (ID-001)                          | `tested`      | 43 database cases + 27 unit cases. Rotation, reuse detection, global cutoff, device list; the append-only ledger is proven immutable under the admin credential                                                                                                                 |
| `apps/api` — identity database path                     | `tested`      | `identityRead` / `identityTransaction`. Zero tenant tables reachable, enforced in `observe` mode as well as `enforce`; no guard event across a whole session lifecycle                                                                                                          |
| `apps/api` — HTTP                                       | `tested`      | NestJS 11 + Fastify. The four-guard pipeline, the stable error envelope, correlation ids, session routes and the first tenant-scoped endpoints: 36 database cases in `http-pipeline.db.test.ts` plus 16 CSRF unit cases and 2 DI cases. Eight mutations confirm the guards fire |
| `apps/web`, `apps/worker`                               | `not_started` | Directories exist, empty                                                                                                                                                                                                                                                        |
| `packages/ui`, `contracts`, `observability`, `test-kit` | `not_started` | Directories exist, empty                                                                                                                                                                                                                                                        |
| CI pipeline                                             | `implemented` | Three jobs written, YAML parses, guards proven to fire under `CI=1`. **Never executed** — no runner here                                                                                                                                                                        |
| Design source audit                                     | `tested`      | 172/172, and now Prettier-idempotent so `audit:design` no longer turns `format:check` red                                                                                                                                                                                       |
| Seed world                                              | `tested`      | Exercised by every database run                                                                                                                                                                                                                                                 |

---

## Design source reconciliation

`docs/design/design-source-audit.md`, regenerated by `pnpm audit:design`.

All **172** screen IDs declared in `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX.md` are present
across the 29 `.dc.html` artifacts. Zero missing. This independently confirms
`design/SESSION-HANDOFF.md` and supersedes the stale `mapped` / "no prototype" /
"no tablet composition" rows in the export's own `screen-status.md` and
`design-quality-scorecard.md`. The immutable export was **not** edited to correct its ledger.

### Human-validation items — genuinely open, not passed

1. Real NVDA and VoiceOver pass over the golden journeys.
2. Native Arabic screen-reader review of the RTL surfaces.
3. Client Portal evidence at 200% browser zoom.
4. Final high-contrast verification against the shipped implementation.

---

## Environment constraints on this machine

Verified 2026-08-16: Node 22.22.0 · npm 11.11.0 · git 2.53 · pnpm 10.15.0 (installed to
`%LOCALAPPDATA%\npm-global`, added to user PATH).

**Absent:** Docker, any container runtime, WSL distribution, local MySQL/MariaDB.

Handled by ADR-0002 via driver ports. The database substitute (`mysql-memory-server`) runs
a real MySQL server — confirmed again this session at **MySQL 8.0.45**: the corpus exercises
real InnoDB composite foreign keys, real `SIGNAL` triggers, and real strict-mode truncation
refusal.

Two gaps follow from the absent container runtime, and neither is closed by anything in this
session:

1. **Local is MySQL, deployed is MariaDB.** The workflow that closes this is now written and
   the corpus now refuses to pass under `CI` on the wrong engine — but the workflow has not
   run, so the gap is unchanged in substance.
2. **`compose.yaml` has still never been started.** The init-mount defect in it was found by
   reading, and the fix is reasoned rather than observed.

Everything below the line "pending CI" in the PLAT-003 section is in this category. No
containerised run is claimed anywhere in this document.

---

## Decisions recorded

| ADR        | Decision                                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADR-0001` | Tenant isolation on MySQL: five layers replacing RLS — composite tenant FKs, least-privilege runtime user, query guard, lint boundary, adversarial corpus |
| `ADR-0002` | Local substitutes without a container runtime; fidelity limits stated per driver                                                                          |

Layers 1, 3, 4 and 5 are implemented and tested against a real server.

**Layer 3 now has exactly one waiver, and it is bounded.** The membership resolver's
bootstrap read cannot carry a tenant predicate, because it is what establishes the tenant.
It is the second audited use of the escape hatch (the outbox relay is the first) and the
only one that is also read-only and restricted to a declared table allowlist. Every
statement it issues emits a security event carrying its reason. Nothing else in the
application may reach that path, and a test asserts that assembling a principal immediately
afterwards emits no guard event at all.

**ID-001's identity path is not a second waiver, and the distinction is tested.** Session
authentication also runs without a `TenantContext`, but it has nothing to waive: it touches no
tenant-owned table, so the guard runs in ordinary `enforce` mode and finds nothing to object
to. An independent check refuses any statement mentioning a tenant table before the guard runs
and in `observe` mode as well — so a guard mode set for a documented incident cannot turn the
pre-authentication path into a route to tenant data. Layer 3 still has exactly one waiver.

**Layer 2 (least-privilege database users) has moved but is not delivered.** It is now
implemented as SQL that has been corrected against three real defects, is held to the schema
by 12 static assertions that run on every commit, and has 20 dynamic cases plus a
whole-corpus re-run waiting for it in CI. What it still does not have is a single execution
against a database server. Until the workflow runs, layer 2 is _verified by construction and
unverified by observation_ — which is better than the previous session's position and is not
the same thing as proven.

Engine and access layer are **fixed by the pack** (`03-TECHNICAL-ARCHITECTURE` §2), so
neither was an open decision. ADR-0001 decides only what replaces row-level security.

---

## Next task (recommended)

**Push to a remote and let the workflow run.** This is not a coding task and it is the only
thing that discharges PLAT-003. The repository has **one commit** (`3206036`) and **no
remote**.
Until CI executes once, the following are written but unobserved: the containerised MariaDB
run, `scripts/db/users.sql` against a server, the 20 least-privilege cases, the isolation
corpus under `tmanage_app`, gitleaks, and `pnpm audit`.

Expect the first run to find things. The most likely places, in order:

1. **MariaDB-vs-MySQL divergence in the two `information_schema` suites.** MariaDB
   implements `JSON` as `LONGTEXT` with an automatic `CHECK (json_valid(...))` constraint,
   so `COLUMN_TYPE` reads `longtext` there and `json` on MySQL. `schema.db.test.ts` already
   normalises that equivalence explicitly — but the normalisation was written from
   documentation and has only ever been exercised against MySQL. This is the single most
   likely first-run failure, and it is a test-expectation fix, not a schema fix.
2. **`SHOW GRANTS` shape and error codes.** MariaDB's grant output and error strings differ
   from MySQL's in wording; the least-privilege suite asserts on error _codes_ specifically
   to survive that, but the codes themselves are unconfirmed on MariaDB.
3. **gitleaks findings in `docs/planning/` and `docs/design/source/`.** Both are immutable
   copies of the planning pack and cannot be edited to satisfy a scanner — a finding there
   has to be resolved in the pack or allowlisted with a reason.

Fix what it finds in the SQL, the test expectations and the workflow. Do not weaken an
assertion to make the first green run happen sooner.

**Then, in dependency order:**

1. ~~The membership resolver~~ — **done.** 24 database cases; the escape hatch is audited,
   read-only and table-limited, and all three constraints are mutation-tested.
2. ~~The remaining TEN-001 repositories and TEN-002's wiring~~ — **done**, with the four named
   gaps recorded under Sprint 1 above.
3. ~~ID-001, §3 step 1~~ — **done.** 43 database cases and 27 unit cases; twelve mutations
   confirm the guards fire. Seven named gaps recorded above, of which the first — nothing yet
   authenticates a person — is the one that matters for sequencing.
4. ~~The HTTP surface~~ (NestJS + Fastify) — **done this session.** The four-guard pipeline
   runs §3's steps in order for a real request: `SessionAuthGuard` (401) → `CsrfGuard` (403) →
   `TenantContextGuard` (404) → `CapabilityGuard` (403). 36 database cases, eight mutations,
   two ADRs (0003, 0004). Six named gaps recorded above.
5. ~~PROJ-001's remaining repositories~~ — **done this session.** Client organizations, client
   memberships, project memberships and work items, 49 database cases, no migration. Two
   findings recorded under PROJ-001 above, one of which (`work_items.state DEFAULT 'triage'`)
   needs a decision before it is fixed, because fixing it is a migration.
6. **The next coding task is a choice between two, and it is a real choice:**
   - **AUD-001** — the audit service. Every refusal in the pipeline already carries an exact
     `auditCode` and nothing consumes it; `ProjectMembershipsRepository.remove()` already
     returns a boolean whose only purpose is to tell an audit writer whether anything was
     revoked. Two named gaps close the moment it exists.
   - **CLIENT-001** — the client portal endpoints. The storage half is now complete, and one
     assertion in `http-pipeline.db.test.ts` is explicitly parked until there is a client
     endpoint to make it against ("a client sees only their own client organization's
     projects").

**A note on ordering.** ID-002 (passwords/passkeys/MFA) is what makes `SessionService.start()`
reachable by a real person. The HTTP surface can be built and tested before it — a sign-in
route that calls `start()` with a `userId` established by a clearly-labelled development-only
path is honest, where a session layer that pretended to authenticate would not be. Which comes
first is a scheduling call, not a correctness one.
