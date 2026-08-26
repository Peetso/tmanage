# TManage — implementation status

Status vocabulary is fixed by `15-AI-EXECUTION-HANDBOOK.md` §6:
`not_started` · `designed` · `design_validated` · `contract_defined` · `implemented` ·
`tested` · `release_ready` · `released`.

A row is only `tested` if a check was **actually executed** and its result recorded below.

**Last updated:** 2026-08-26 · **Deployment profile:** `bootstrap` (50-BOOTSTRAP)

---

## Machine and toolchain — read before running anything

Recorded because two things about this machine have changed since the last session, and both
change what a command does rather than merely how it is typed.

| Fact                             | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pnpm is not installed**        | There is no `pnpm` on `PATH`. Provision it with `corepack enable pnpm --install-directory <dir>` and prepend that directory. Inside the repository it then resolves to **10.15.0** via `packageManager`, verified before any gate was run this session. Note for a POSIX shell on Windows: `PATH` entries must be `/c/Users/...`, not `C:/Users/...` — a drive-letter colon is a `PATH` separator, so the entry is silently discarded                                                                                                                                                                                             |
| Node                             | 22.22.0 · corepack 0.34.0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Git state**                    | Nine commits on `master`, pushed to **`https://github.com/Peetso/tmanage` (private)**. `user.name` / `user.email` are set repo-locally. The remote was added on 2026-08-25 after Peter authenticated `gh` himself                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Containers                       | Still absent: no Docker, no container runtime, no Linux distro under WSL 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **A local MySQL does exist**     | Corrected 2026-08-25. Earlier revisions of this table said there was "no local MySQL or MariaDB". There is: **MySQL Server 8.0 is installed** at `C:\Program Files\MySQL\MySQL Server 8.0`, registered as service `MySQL80` (**Stopped**, start type Manual, nothing listening on 3306). It matters because `mysql-memory-server` runs **that binary** rather than downloading one — the `mysqld` processes the suite starts are `C:\Program Files\MySQL\...\mysqld` on a random high port with a scratch datadir under `%TEMP%\mysqlmsn`. ADR-0002's "a real MySQL server binary" is therefore true, but it is the installed one |
| **Check for strays after a run** | `pnpm test:db` has been observed to **leak one `mysqld`** after the suite exits. Check with `Get-Process mysqld` and stop it by PID; a leaked server holds a scratch datadir and a port                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **MariaDB, without a container** | As of 2026-08-25 there **is** a local MariaDB: the plain `mariadb-11.4.5-winx64` zip, the same version `compose.yaml` pins, needing no installer and no administrator rights. Started with compose.yaml's own server flags, it runs the whole database suite. Two Windows traps: the data directory must sit on a **short path** (`MAX_PATH` truncates trigger `.TRN~` files and the failure reads as `Errcode: 2 "No such file or directory"`), and `mariadb-install-db.exe` cannot run without an interactive stdin — bootstrap `mariadbd --bootstrap` directly instead                                                         |
| File encoding                    | Source must not be edited through PowerShell `Get-Content` / `Set-Content`: it re-encodes UTF-8 and corrupts every em dash and `§` in this codebase's comments. Bash heredocs with a quoted delimiter are safe                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **A stale second copy**          | `outputs/TManage-Planning-Pack/tmanage/` is a duplicate of this repository and is **stale as of 2026-08-24**: it is missing every file from the HTTP-surface and PROJ-001 sessions, its `implementation-status.md` is an older revision, and its git repository holds **zero commits**, so it preserves nothing this one lacks. Kept on purpose (Peter's decision, 2026-08-25). **Never edit it and never read it as current** — the live repository is `tmanage/`                                                                                                                                                                |

---

## Planning-pack reconciliation — re-verified 2026-08-26, start of the REQ-001 session

The table below is this run's output rather than a copy of the previous one. Every pair was
compared by SHA-256 and by modification time individually; the comparison filters the pack's own `tmanage/`, `graphify-out/` and design-handoff subtrees,
without which the planning scope reports a spurious "10 differing".

| Scope                                     | Result                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/planning/` vs the pack (SHA-256)    | **61 of 61 byte-identical.** 0 differ, 0 missing, 0 repo-only                                                                                                                                                                                                                                   |
| `docs/design/source/` vs the pack handoff | **147 of 147 byte-identical.** 0 differ, 0 missing, 0 repo-only, 0 pack-only                                                                                                                                                                                                                    |
| Modification times                        | **No pack file is newer than its copy** in either scope, compared pair by pair. All 60 planning pairs and all 147 design pairs have the repo copy stamped later, which is what a copy taken _from_ the pack looks like                                                                          |
| Uncopied pack content                     | The same five as every previous run, all deliberate: the design-handoff `.zip` (extracted into `docs/design/source/`), `TManage-Product-System-Master-Plan.docx`, and three Claude Code tooling files for the pack folder — `CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json` |
| Conclusion                                | Nothing revised since the previous check. Safe to write code                                                                                                                                                                                                                                    |

Nothing under `docs/planning/` or `docs/design/source/` was written to this session. A stale
copy is refreshed _from_ the pack and never authored.

---

## Planning-pack reconciliation — re-verified 2026-08-26, start of the UI-001 session

The **ninth** consecutive run, and the table below is that run's output rather than a copy of
the previous one. It matters more than usual this session: UI-001 copies values out of the
design export, so a stale copy would have been baked into a package rather than merely read.

| Scope                                     | Result                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/planning/` vs the pack (SHA-256)    | **61 of 61 byte-identical.** 0 differ, 0 missing, 0 extra                                                                                                                                                                                                                                       |
| `docs/design/source/` vs the pack handoff | **147 of 147 byte-identical.** 0 differ, 0 missing, 0 repo-only, 0 pack-only                                                                                                                                                                                                                    |
| Modification times                        | **No pack file is newer than its copy**, compared pair by pair rather than newest-against-newest                                                                                                                                                                                                |
| Uncopied pack content                     | The same five as every previous run, all deliberate: the design-handoff `.zip` (extracted into `docs/design/source/`), `TManage-Product-System-Master-Plan.docx`, and three Claude Code tooling files for the pack folder — `CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json` |
| Conclusion                                | Nothing revised since the previous check. Safe to write code                                                                                                                                                                                                                                    |

Nothing under `docs/planning/` or `docs/design/source/` was written to this session. The token
package reads the export at **test time** and never copies it into the repository, so the
relationship stays one-directional by construction rather than by discipline.

---

## Planning-pack reconciliation — re-verified 2026-08-26, start of the AUD-001 session

Run before a line of code was written, for the reason the re-baseline notice below gives.
This is the **eighth** consecutive run with the same result, and the table below is that
run's output rather than a copy of the previous one.

| Scope                                     | Result                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/planning/` vs the pack (SHA-256)    | **61 of 61 byte-identical.** 0 differ, 0 missing, 0 extra                                                                                                                                                                                                                                  |
| `docs/design/source/` vs the pack handoff | **147 of 147 byte-identical.** 0 differ, 0 missing, 0 repo-only, 0 pack-only                                                                                                                                                                                                               |
| Modification times                        | **No pack file is newer than its copy**, compared pair by pair rather than newest-against-newest                                                                                                                                                                                           |
| Uncopied pack content                     | The same as every previous run, all deliberate: the design-handoff `.zip` (extracted into `docs/design/source/`), `TManage-Product-System-Master-Plan.docx`, and three Claude Code tooling files for the pack folder — `CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json` |
| Conclusion                                | Nothing revised since the previous check. Safe to write code                                                                                                                                                                                                                               |

Nothing under `docs/planning/` or `docs/design/source/` was written to this session.

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

## Verification actually run — 2026-08-26, the REQ-002 session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`735 s` wall (12 m 15 s), **exit 0**.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                                                  |
| `typecheck`              | Clean across five projects                                                                                          |
| `lint`                   | Clean                                                                                                               |
| `test` (unit)            | **770 passed**, 34 files — config 25, domain 102, ui 106, api 241, web 296. Unchanged: REQ-002 adds no unit surface |
| `test:db`                | **592 passed, 22 skipped**, 20 files, **651.96 s**. Was 581/22; **+11**, all in REQ-002's two new blocks            |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                                               |
| `format:check` (closing) | Clean                                                                                                               |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run                                                           |

`next build` was **not** re-run and no claim is made about it. REQ-002 adds no route to
`apps/web`; the twenty routes recorded in the WEB-004 section are unchanged.

REQ-002 adds twelve cases and the file gained eleven, because one REQ-001 case was **replaced
rather than kept**: the acceptance-through-`/transitions` path it asserted no longer exists, and
the case that stands in its place asserts the refusal instead.

---

## REQ-002 — an acceptance and its work, as one thing

`REQ-001` could store the link `23-ERD` §6 requires and had no way to make it true. A manager
accepted a request by supplying the id of a work item created separately, so an acceptance and
its work were **two writes that could each succeed without the other** — and a failed
acceptance left a task in the plan describing work nobody had agreed to.

US-B02: "transition rules enforced; client-safe reason required for decline/defer; acceptance
records committed scope/date **and linked work**; actor/time/history immutable." The first two
were REQ-001's. This ticket is the third and the fourth.

### What shipped

| Piece                               | What it is                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `ClientRequestsService.accept`      | The work item, the transition and both audit rows in **one** `database.transaction`             |
| `POST :clientRequestId/acceptance`  | The only door onto `accepted`                                                                   |
| `POST :clientRequestId/transitions` | Now **refuses** `to: 'accepted'`, with a message naming the route that does it                  |
| `ClientRequestsService.historyOf`   | US-B02's "actor/time/history immutable", as a read of `audit_events`                            |
| `GET :clientRequestId/history`      | The trail a triage decision is accounted for by                                                 |
| `readForMove`                       | The read and the two authority checks, extracted so the two doors cannot check different things |
| 12 database cases                   | On top of REQ-001's, in the same file                                                           |

**No migration and no new table.** The link, the scope summary and the commitment are all
columns `0006_client_requests.sql` already has; what was missing was a transaction around them.

### Three decisions

**1. One door onto `accepted`, and the old one refuses out loud.** `POST :id/transitions` could
have kept accepting — the machine would still have enforced §6's requirements. It does not,
because a second acceptance path is a path that can link work created anywhere, which is exactly
the two-write shape this ticket removes. The refusal is a 400 naming
`POST :id/acceptance`, so the next person to look for it finds it rather than reinventing it.

**2. Linking existing work goes through the same door.** A manager who already made the task
passes `linkedWorkItemId` and nothing is created. Supplying both that and a `work` object is
refused rather than resolved by preference — two different pieces of work for one acceptance is
a body with two meanings, and picking one silently is how the wrong task gets linked.

**3. The created work item is `internal`.** `DEFAULT_AUDIENCE`, and the temptation was real: the
client asked for this, so surely they may watch it. That would make widening a **side effect of
a different decision**, which is precisely what `25-AUTH-AND-TENANT-ISOLATION` §7 forbids. What
the client is owed is the answer to their request, and they get it — the request's own
projection carries the accepted status, the client-safe scope summary and the committed date.
An `audience` on the body widens it deliberately and is audited as the publication decision it
is; a test proves that path reaches the portal.

### The history is a read, not a table

US-B02 asks for "actor/time/history immutable" and this codebase already has all three.
`audit_events` carries the actor, the time and the correlation id; `0002_platform_primitives.sql`
makes it append-only by trigger, and `users.sql` grants the runtime credential `INSERT` and
nothing else. So the endpoint is a read through `AuditService.historyOf`, which applies its own
`audit.read` check and its own scope narrowing.

A `client_request_events` table would have been a second copy of that trail, and — unlike the
first — a mutable one. A test asserts the immutability at the engine rather than at the
endpoint, because that is where it actually lives.

### Idempotency, considered and not built

`27-TEST-CATALOG` CONC-01 asks about "duplicate client requests with same idempotency key", and
`idempotency_records` has existed since `0002` with no writer. It is **not** used here, and the
reason is that this aggregate already has a stronger guard for the case that matters: a retried
acceptance carries the version it read, and the second attempt gets a 409 rather than a second
work item. A test proves it. An idempotency key would add a second mechanism answering a
question the first already answers, and CONC-01's actual subject — duplicate _submissions_ from
a client — is a different case that `REQ-001` does not deduplicate and this does not claim to.

### Named gaps in REQ-002, carried deliberately

1. **No triage screen.** `WEB-005 manager triage screen and schedule impact`, 8 points,
   depending on REQ-002 — the plan's own ticket, and this file previously said the screen
   "belongs with REQ-002", which was wrong and is corrected here. `TM-12` is API-only today,
   exactly as `CL-06` was before this session.
2. **No schedule-impact preview.** `22-SCREEN-BY-SCREEN` §5 TM-12 asks for one _before_ accept.
   Nothing computes capacity or schedule, so there is nothing to preview; it is WEB-005's, and
   it needs a capacity model that no ticket has built.
3. **No duplicate suggestion.** TM-12 also lists "duplicate suggestion" and "client history".
   The history endpoint is here; suggesting duplicates is a similarity judgement nothing
   computes, and is recorded rather than approximated.
4. **The linked work item is not visible from the work side.** `work_items` has no column
   pointing back at the request that caused it — the link is one-directional, on
   `client_requests.linked_work_item_id`. Reading "which request is this task for" is a scan
   today. No document asks for the reverse column; it is recorded because the first screen that
   wants it will notice.
5. **`planned` and `delivered` are still manual.** §6 continues `accepted → planned →
delivered`, and nothing moves a request when its linked work item does. That is a rule
   connecting two lifecycles and it belongs with the outbox relay (`PLAT-004`) rather than
   inside a request handler.
6. **The work item's type is always `task`.** Not configurable on the acceptance body. No
   document enumerates the types either — `work_items.type` is a `VARCHAR(32)` with a `'task'`
   default — so this is the same open vocabulary the `category` gap records.

---

## Verification actually run — 2026-08-26, the WEB-004 second-half session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`712 s` wall (11 m 52 s), **exit 0**.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                                               |
| `typecheck`              | Clean across five projects                                                                                       |
| `lint`                   | Clean                                                                                                            |
| `test` (unit)            | **770 passed**, 34 files — config 25, domain 102, ui 106, api 241, **web 296**. Was 749; one new suite, 21 cases |
| `test:db`                | **581 passed, 22 skipped**, 20 files, **629.78 s**. One case more than the REQ-001 run: `canWithdraw`            |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                                            |
| `format:check` (closing) | Clean                                                                                                            |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run                                                        |

`next build` was run separately and succeeded: **twenty routes**, was seventeen. The three new
ones are `/[orgSlug]/portal/requests`, `/[orgSlug]/portal/requests/new` and
`/[orgSlug]/portal/requests/[requestId]`.

**This is the second chain of this session for this ticket, and the first is not being reported
as the result.** The first also passed — 770 unit and 581/22 database — and was then discarded
because re-reading the new code found two defects it could not have caught: a comment that
described its own function wrongly, and a confirmation screen with no link out of it. Both were
fixed and the whole chain re-run. A green chain over code with a known defect in it is not a
result.

The 22 skips are the 21 least-privilege cases every previous session records, plus REQ-001's
grant assertion, which needs the same credential.

---

## WEB-004's second half — the screens a client asks through

`REQ-001` built the client request and gave it no screen. A client could submit one only by
making an HTTP call, which nobody outside this repository will do. This is `CL-06` in
`22-SCREEN-BY-SCREEN` §6 — "New request / request detail" — and `CL-09` plus `CL-10` in
`41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §9. Those two documents disagree about the numbering,
which is recorded below rather than resolved.

### What shipped

| Piece                                           | What it is                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `NewClientRequestScreen`                        | `CL-09`. The form, the pre-send summary, and §6's bolded confirmation                |
| `ClientRequestDetailScreen`                     | `CL-10`. Status, the studio's reason, the two dates, and withdrawal                  |
| `ClientRequestsScreen`                          | The client's own list. **No screen ID** — see the divergence below                   |
| `lib/client-request-presentation.ts`            | One place where a status becomes a capsule, a word and a sentence                    |
| `lib/api/portal.ts`                             | Four endpoints: submit, list, get, withdraw                                          |
| Three routes under `/[orgSlug]/portal/requests` | `new`, `[requestId]`, and the list                                                   |
| `ClientOverviewScreen`                          | A requests section and the way in to asking. `REQ-001` removed from its pending list |
| `ClientActionsScreen`                           | `CL-02`'s **second kind of card**, which is the whole reason this follows REQ-001    |
| `client_requests.can_withdraw`                  | Not a column — a field on the client projection. See below                           |
| `.tm-field__control--multiline`                 | One CSS class. A textarea inherits the 40px control height and needs not to          |

### `canWithdraw` is an API change this ticket made, and the reason is the projection

The client projection collapses `triage` into `submitted`, because `22` §6's CL-06 lists seven
statuses and `triage` is not among them: a studio that has opened a request and not answered it
is not a separate thing for the client to watch.

That collapse makes one question unanswerable from the client's data. `23-ERD` §6 draws
`submitted → withdrawn` and `needs_clarification → withdrawn` and **no arrow out of `triage`**,
so a Withdraw button rendered from `status` would appear on every fresh-looking request and fail
on the ones somebody had picked up.

So the projection carries `canWithdraw`, asked of `clientRequestStateMachine` rather than
restated. It discloses nothing a client should not have — "may I take this back" is a fact about
their own options — and the screen says the reason out loud when the answer is no, because a
control that silently vanishes reads as a fault.

This is the second consequence of the §6 finding recorded in the REQ-001 section, and it is
worth stating as a rule: **a lossy projection has to carry the answers its losses make
unavailable**, or the loss reappears as a broken control.

### Two divergences inside the planning pack, recorded rather than resolved

**1. The client portal has two incompatible screen numberings.** `22-SCREEN-BY-SCREEN` §6 lists
eleven client screens with `CL-06 New request / request detail`.
`41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §9 lists **sixteen**, splits that into `CL-09 New
request` and `CL-10 Request detail`, and uses `CL-06` for **Request changes** — which is `22`'s
`CL-04`. Every client ID from `CL-03` onward means something different in the two documents.

`audit:design` counts screen IDs against `41`, and the design artifacts carry `41`'s IDs, so the
code names **both** on every screen. Neither document was edited; both are immutable.

**2. The design draws a "Requests" section the navigation does not have.** The `CL-09` and
`CL-10` artifacts both carry a breadcrumb reading "Requests · New request". `22` §1 fixes the
client rail at seven destinations — "Overview, My Actions, Deliverables, Timeline, Updates,
Files, People" — and Requests is not one of them.

`CLIENT_NAVIGATION` was **not** touched. A rail item §1 does not list would be a destination
this codebase invented, and the shell's own comment says the client list "must never be derived"
from the internal one — inventing entries is the same failure from the other direction. The
requests are reached from `CL-01 Overview` and from `CL-02 My Actions` instead, and a test
asserts the rail still contains no request link.

### The date is said three times, and that is the specification's doing

§6's one bolded requirement for this screen is "**Confirmation states date is uncommitted**",
and the design artifact's own caption is blunter: "A DESIRED DATE IS A WISH, NOT A COMMITMENT".

So the field is labelled "When you would like it" and never "Due date"; the summary before
sending shows the value behind an `Asked for` capsule; and the confirmation repeats it with a
panel headed "Nothing is scheduled yet". On the detail screen the two dates are separate rows
with different labels — "You asked for" and "Northstar Studio agreed" — and the second exists
only once somebody accepted.

`REQ-001` already keeps them apart in storage, so none of this is compensating for a data model
that confuses them. It is said out loud because a client who types a date into a form has, in
every other product they have used, just set a deadline.

### Two defects found by re-reading, before the chain was recorded

1. **A comment that described the code wrongly.** `startOfDay` produces midnight **UTC**; its
   comment said the day was sent "as its own start in the reader's zone". The comment was wrong,
   not the code — see the gap below — and a comment that misdescribes what it sits above is
   worse than none.
2. **A confirmation that led nowhere.** After sending, the form was replaced by a confirmation
   with no link to the new request and no link back. The only way to either was the browser's
   back button, which re-mounts an empty form and reads as though the request was lost. Two
   links added, and asserted.

### Named gaps in WEB-004's second half, carried deliberately

1. **No file attachment.** §6 lists files and US-B01 requires "valid files scanned". `FILE-001`
   is unbuilt and nothing in this system scans anything, so there is no file input at all. A
   test asserts the absence, which is the only way an absence stays deliberate.
2. **No draft.** The design draws a "Save as draft" button. `23-ERD` §6's machine has no draft
   state — `submitted` is the initial one — so a draft would be a state the lifecycle does not
   have.
3. **No conversation.** The `CL-10` artifact's largest panel is a message thread with a reply
   box. That is `CONV-001`; there is no `messages` table. The one thing the studio can say to a
   client today is a clarification question, and it is rendered as prominently as the artifact
   renders the thread — **but the client cannot answer it in the portal.** They are told to reply
   however they normally reach the studio, which is the honest instruction and a poor product.
4. **No names.** The artifact names four people under "Who will see this". Nothing returns a
   person's name to a client — `CL-13 People`, "approved contacts only", is unbuilt — so the
   audience is stated as the two groups it actually is.
5. **No "similar things you asked for".** The artifact lists two. Similarity is a judgement
   nothing computes; the list shows what the client has actually sent instead.
6. **A calendar date is stored as an instant, and it can read back a day early.**
   `client_requests.desired_at` is `DATETIME(3)`, and the screen sends midnight UTC — the same
   convention `ProjectsController.parseTargetDate` already uses for `targetDate`. A client west
   of UTC picks 3 September and `Intl.DateTimeFormat` in their own zone reads it back as 2
   September. **This is not new and it is not confined to this screen**: `projects.forecast_at`
   and `committed_at` have carried it since PROJ-002, and `CL-01` renders both. The fix is a
   `DATE` column for a date that has no time, which is a migration; one convention that is
   occasionally off by a day was chosen over two conventions that disagree.
7. **`activeNavigationId="overview"`** on all three request screens. The rail highlights Overview
   while a person is on a request page, because there is no rail item to highlight — a
   consequence of divergence 2 above rather than an oversight.
8. **Three of `CL-02`'s five card types are still missing.** §6 lists "approval, feedback,
   upload, answer, client task". The answer card is new here and the client task has existed
   since CLIENT-002; approvals are `APPR-001` and uploads are `FILE-001`.

---

## Verification actually run — 2026-08-26, the REQ-001 session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`731 s` wall (12 m 11 s), **exit 0**.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                                                  |
| `typecheck`              | Clean across five projects                                                                                          |
| `lint`                   | Clean                                                                                                               |
| `test` (unit)            | **749 passed**, 34 files — config 25, domain 102, ui 106, api 241, web 275. Unchanged: REQ-001 adds no unit surface |
| `test:db`                | **580 passed, 22 skipped**, 20 files, **630.31 s**. Was 542 passed / 21 skipped across 19                           |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                                               |
| `format:check` (closing) | Clean                                                                                                               |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run                                                           |

The database delta is **+38 passed and +1 skipped**, and it decomposes exactly: 35 passed and
1 skipped in the new `req-001-client-requests.db.test.ts`, plus 3 in `schema.db.test.ts`,
which generates a columns / nullability / types case per table and now has one more table to
generate them for. The single new skip is the least-privilege grant assertion, which needs
`TMANAGE_TEST_APP_DATABASE_URL` and is **recorded as a skip, not as a pass**.

`next build` was **not** re-run this session and no claim is made about it. REQ-001 adds no
route to `apps/web`; the seventeen routes recorded in the WEB-004 section are unchanged.

---

## REQ-001 — the client request, and the answer the portal could not give

`CLIENT-002` and `WEB-004` between them gave a client a portal they could open and read.
`12-PERMISSION-MATRIX` §2 gives **every** client role `client_request.submit` — it is the one
capability all four of them share, and the only write a client principal makes anywhere in
this system — and until this ticket there was nothing to submit to. A client could be shown
work and could not answer.

The ticket is `28-SPRINT-TICKETS` §7's "client request aggregate/API/projection", eight points,
its one dependency (`CLIENT-001`) long met.

### What shipped

| Piece                                            | What it is                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `migrations/0006_client_requests.sql`            | One table, four foreign keys (three composite and tenant-carrying), two indexes, two triggers    |
| `schema.ts`                                      | The Drizzle mirror, plus `client_requests` in `TABLES`                                           |
| `tenant-guard.ts`                                | `client_requests` registered in `TENANT_TABLES`, so it cannot be read without a tenant predicate |
| `scripts/db/users.sql`                           | `INSERT, UPDATE` for `tmanage_app`. **No DELETE** — see below                                    |
| `packages/domain/policies/audit.ts`              | Two new actions: `client_request.submitted`, `client_request.transitioned`                       |
| `modules/requests/client-requests.repository.ts` | Storage. `submit`, `findById`, `list`, `transitionState`. No `update`, no delete of any kind     |
| `modules/requests/client-requests.service.ts`    | The aggregate and **both** of its projections                                                    |
| `modules/requests/client-request-input.ts`       | Body parsing shared by the two doors, so they cannot drift into accepting different things       |
| `modules/requests/client-requests.controller.ts` | The studio's `/client-requests` — list, get, transitions                                         |
| `clients/portal.controller.ts`                   | The client's `/portal/requests` — submit, list, get, withdrawal                                  |
| `test/req-001-client-requests.db.test.ts`        | 35 database cases over real HTTP, 1 skipped                                                      |

The state machine was **not** written this session. `clientRequestStateMachine` has been in
`packages/domain` since the state-machine work, with `23-ERD` §6's transitions, its `requires`
lists, and the two constants that divide it between a manager and a client. This ticket
consumes it and adds nothing to it, which is the point: a second copy of a lifecycle is a
second copy free to disagree.

### Six decisions worth the paragraphs

**1. The two dates are two columns, and only one of them is a promise.** `desired_at` is what
the client asked for; `committed_at` can only be written by an acceptance. US-B01's acceptance
criterion is "visible acknowledgement that date is requested, not committed", and a single
column whose meaning changed with the state would have made that a caption on a screen rather
than a fact about the row.

**2. A commitment is one choice, not two nullable columns.** §6 asks for a "committed date or
explicit unscheduled state". The API takes one field — `"unscheduled"` or an ISO 8601 instant —
and the row stores `commitment` plus `committed_at`. A `BEFORE INSERT` and a `BEFORE UPDATE`
trigger refuse every incoherent pairing, so `commitment = 'committed'` with no date (a promise
nobody made) and a date with no commitment (one nobody recorded) are both impossible at the
engine, including on a direct SQL session where ADR-0001 layers 3 and 4 do not run.

**3. Only a transition writes the facts a transition required.** There is **no `update()` on
the repository and no `PATCH` on either controller.** `clarification_question`,
`client_visible_reason`, `client_safe_scope_summary`, `commitment`, `committed_at` and
`linked_work_item_id` are written in the same statement as the state. So there is no path that
sets a decline reason without declining, and no path that edits the scope summary a client was
shown after they were shown it. A reason in this table is evidence that the decision it belongs
to was taken.

**4. `state` has no `DEFAULT`, and that is a correction of a defect this file already carries.**
`work_items.state` has `DEFAULT 'triage'` in `0001_tenancy.sql`, and `triage` is not a
work-item state at all — it belongs to _this_ lifecycle. It is latent because every writer
names the column. The lesson is that a default is a second opinion about a lifecycle, free to
be wrong and invisible when it is, so this column has none: under `STRICT_ALL_TABLES` an insert
that forgets the state fails. A test asserts exactly that. **The `work_items` defect is still
there** — correcting it is a migration and was not in this ticket's scope.

**5. There is no delete, and the absence is structural.** Every other aggregate here is
soft-deleted; this one cannot be removed at all. §6 gives the **client** `withdrawn` and gives
the studio no exit, and `users.sql` grants the runtime credential `INSERT, UPDATE` and nothing
else. An agency able to make an awkward request disappear would be an agency whose request log
proves nothing.

**6. Audience is derived, not stored — and it is what makes `CL-02` work.** A request in
`needs_clarification` has audience `client_action_required`; every other state is
`client_visible`. So a clarification arrives in the client's action queue without anything
having to remember to put it there, and `authorize()` rules 7 to 10 gate the row without a
second copy of the state to fall out of step with the first.

### Reading has no capability of its own, and that was deliberate

`12-PERMISSION-MATRIX` §2 gives this aggregate exactly two capabilities: `client_request.submit`
(all four client roles, no internal role) and `client_request.triage` (`owner`, `org_admin`,
`workspace_admin`, `manager` — and it is in `INTERNAL_ONLY_CAPABILITIES`). There is no
`client_request.read`. Reading is therefore carried by the capability describing what the
reader is there to do. Inventing a third would have put a permission in the code that no role
in the matrix can be granted — the same argument `WorkItemsController` makes for deleting under
`work.update`.

One consequence is worth stating plainly: **there is no `POST /client-requests`.** Submission
happens only on the portal path, because an internal create endpoint would be a way for the
agency to file requests as its own clients.

### One finding, from the suite rather than from reading

**§6 has no `triage → withdrawn` arrow.** The prose says "Client may withdraw before
delivered", and the diagram draws `submitted → withdrawn` and `needs_clarification → withdrawn`
and nothing out of `triage`. So the client's right to withdraw is narrower than the sentence
sounds: once somebody at the studio has picked the request up, withdrawing it is a conversation
rather than a button, and it becomes possible again only if the studio asks a question.

This surfaced as a **failing test** — a concurrency case written expecting 409 got 422, because
the machine refused the move before the version token was ever checked. The test was wrong and
the code was right. It has been rewritten around a genuinely stale token (two managers holding
version 1, one of them triaging first), and the discovery is now two tests of its own.

### Named gaps in REQ-001, carried deliberately

1. **Files.** `CL-06` lists "Title, category, description, urgency reason, desired date,
   **files**" and US-B01 requires "valid files scanned". `FILE-001` has not shipped, there is
   no `file_assets` table and nothing in this system scans anything, so **no field accepts a
   file or a file id**. Accepting attachment ids nothing had checked would have been worse than
   the omission.
2. **Nothing is notified.** US-B01 asks for a bundled notification and `24-EVENT-CATALOG` §1
   lists `client_request.submitted.v1` and `client_request.transitioned.v1` as durable events.
   **Neither is published.** `outbox_events` has existed since `0002` and has no producer
   anywhere in this codebase; `apps/worker` is still an empty directory. That is `PLAT-004`,
   and REQ-001 does not pre-empt it — a producer with no relay would put rows in a table
   nothing drains.
3. **`REQ-002` is not started.** An acceptance requires `linkedWorkItemId`, and this ticket
   **stores and validates** the link — a scoped read proves the work item is in this tenant, so
   a wrong id is a 422 naming the field rather than a foreign-key violation surfacing as a 500.
   It does **not create** the work item. "Triage/clarify/accept linked work transaction" is
   REQ-002's eight points, and until it lands a manager must have created the work item first.
4. **`category` has no vocabulary anywhere in the pack.** CL-06 names the field and no document
   enumerates its values. The column is free text, and the _shape_ is constrained to a slug
   (`new-page`, `bug_report`) because the category is recorded as a classification in the audit
   metadata and `isSafeAuditMetadata` admits no spaces — an unconstrained category would have
   made every submission a 500 at the write boundary. The vocabulary is left open and this is
   the record that it was left open rather than guessed.
5. **`withdrawn` is not in CL-06's status list.** CL-06 gives seven —
   submitted/clarifying/accepted/deferred/declined/planned/delivered — and the client
   projection returns an eighth. Added because the client is the one who causes it, and a
   request that vanished from their own list would be worse than one labelled. Recorded as an
   addition to the screen's vocabulary rather than a transcription of it.
6. **`triage` is shown to the client as `submitted`.** CL-06 does not list `triage`, so the
   projection collapses it. A studio that has opened a request but not answered it is not a
   status a client should be invited to chase — but the client consequently cannot tell "not
   looked at" from "being looked at", and that is a product decision this file is recording
   rather than a limitation of the code.
7. **`CL-02 My Actions` still renders one kind of card.** The request card is not wired to any
   screen — REQ-001 is API and projection only. That is WEB-004's second half.
8. **The least-privilege grant case is skipped** without `TMANAGE_TEST_APP_DATABASE_URL`. It
   asserts that the runtime credential's grant on `client_requests` names no `DELETE`, and in
   the default per-file run there is no such credential to read grants for. Recorded as a skip.

---

## Verification actually run — 2026-08-26, the WEB-004 session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`667 s` wall (11 m 7 s), **exit 0**.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                                                          |
| `typecheck`              | Clean across five projects                                                                                                  |
| `lint`                   | Clean                                                                                                                       |
| `test` (unit)            | **749 passed**, 34 files — config 25, domain 102, ui 106, api 241, **web 275**. Was 736 across 33 — one new suite, 13 cases |
| `test:db`                | **542 passed, 21 skipped**, 19 files, **667.03 s**. Unchanged: WEB-004 adds no database surface                             |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                                                       |
| `format:check` (closing) | Clean                                                                                                                       |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run                                                                   |

`next build` was run separately and succeeded: **seventeen routes**, was fifteen. The two new
ones are `/[orgSlug]/portal` and `/[orgSlug]/portal/actions`.

The 21 skips are the same least-privilege cases as every previous session, and are recorded
as skips.

---

## WEB-004's first half — the portal a client can actually open

`CLIENT-002` built the portal's endpoints and the portal had no screens. `ClientPortalShell`
has existed since `WEB-001` and linked to routes that did not exist, so a client could be
invited, accept, sign in, and land on a 404.

`CL-01 Overview` and `CL-02 My Actions` are the two screens the endpoints already answer.
`CL-03` through `CL-11` need approvals, requests, files and deliverables — none of which has
storage — and are the second half.

### The rule in bold: no internal task percentage

`22-SCREEN-BY-SCREEN` §6 puts it in bold on `CL-01`, and it is the rule a well-meaning screen
breaks first. A progress bar is the obvious thing to draw on a client overview, and a
percentage can only be computed from the internal task list `12-PERMISSION-MATRIX` §4 excludes
from the projection — so a number there would be either a leak or a fabrication.

What the client gets instead: the two dates that mean something to them, the things waiting on
them, and everything that has been shared, in full. The screen **says out loud** that the
missing percentage is a decision, because a client who expects a progress bar and does not find
one should know that somebody chose.

The API could not leak one anyway. `PortalWorkItem` carries no state and no owner, so this
screen could not compute a task percentage if it wanted to — which is the projection doing its
job rather than the screen being careful.

### The empty state is the specification's

§6 on `CL-02`: "empty state confirms notification behavior." A client with nothing to do is
told **both** halves: nothing is waiting on you, and you will be told rather than expected to
keep checking this page. That sentence is the empty state's entire job, so it says both.

### Three things the screens refuse to invent

- **The five card types.** §6 lists approval, feedback, upload, answer and client task, and
  none of them has an aggregate. Every card is the one kind that exists —
  `client_action_required` — and `BackendPending` names the four that do not.
- **"Why", "consequence", "estimated review time".** Three of the four fields §6 wants on each
  card. Nothing stores them. They are named as missing rather than filled with plausible
  sentences: a portal that told a client the consequence of missing a date, and invented it, is
  worse than one that admits it does not know.
- **Ordering.** By due date, soonest first, undated last. §6 asks for "ordered cards" without
  saying by what, and the only ordering this screen can honestly apply is one the client can
  verify from what is on the card. Urgency or importance would be an internal judgement the
  projection does not carry.

### The portal's links now have a tenant in them

`ClientPortalShell` takes an `organizationSlug` and prefixes every navigation href with it.
`CLIENT_NAVIGATION` carries `/portal/actions`; the shell renders `/northstar/portal/actions`.

The portal is tenant-scoped exactly as every other screen is — the slug in the path is the
claim `TenantContextGuard` resolves against a membership row — and the navigation had been
pointing at routes with no tenant in them since `WEB-001`. The test that keeps internal
destinations out of the portal is unchanged in what it protects and now asserts the prefix too.

### Named gaps

1. **Two names are fixtures.** The client organization's own name and the service
   organization's are both invented, because nothing returns either to the people who need to
   read them: `CLIENT-002`'s endpoints answer with projects and work, not with who the reader
   is. Both are cosmetic; every piece of data on the portal is real.
2. **`CL-01` shows one project.** The portal reads the first project shared with this client,
   because `22` §1's "project selector if authorized" has no design decision recorded for the
   multi-project case and inventing one would be guessing. A client with two shared projects
   sees the first and is not told about the second — recorded here because it is the sharpest
   of these gaps.
3. **Milestones, updates, risks and timeline are absent**, named in `BackendPending` rather
   than drawn as empty sections. §6's first viewport lists all four; none has storage.
4. **The portal reads and does not write.** `client_request.submit` is in every client ceiling
   and there is nothing to submit to — `REQ-001` is the aggregate, unbuilt. Approving,
   requesting changes and uploading are all in the same position.

---

## Verification actually run — 2026-08-26, the CLIENT-002 session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`696 s` wall (11 m 36 s), **exit 0**.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                              |
| `typecheck`              | Clean across five projects                                                                      |
| `lint`                   | Clean                                                                                           |
| `test` (unit)            | **736 passed**, 33 files — config 25, domain 102, ui 106, api 241, web 262. Unchanged           |
| `test:db`                | **542 passed, 21 skipped**, 19 files, **695.80 s**. Was 523 across 18 — one new suite, 19 cases |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                           |
| `format:check` (closing) | Clean                                                                                           |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run                                       |

The 21 skips are the same least-privilege cases as every previous session, and are recorded
as skips.

**No failures on the first run**, which is worth noting because it is the first ticket this
session where that was true. The reason is legible rather than lucky: `client_projection.read`
made the classification test in `authorize.test.ts` fail the moment the capability existed, and
that failure — a test demanding a decision about whether a client may hold it — was resolved
before anything else was written.

---

## CLIENT-002 — the client portal, and a capability the plan had and the code did not

`CLIENT-001` gave a client an organization to belong to. `TEN-003` gave them a way in. Neither
gave them anything to look at: every endpoint in this system serves the internal record, and
`12-PERMISSION-MATRIX` §2 gives every client role "View internal project: **Never**". A client
could sign in and see nothing at all.

### The capability was missing from the code, not from the plan

`12-PERMISSION-MATRIX` §1 has a **"View client projection"** row with an entry for all eleven
roles — `Scope`, `Project`, `Explicit`, `Client org`, `Assigned/shared`, `Shared` — and
`CAPABILITIES` in `packages/domain` had no such member. The one surface every client role
exists to read could not be authorized at all, which is why the portal had never been built:
there was nothing to put on the route.

`client_projection.read` now exists, is in every ceiling the matrix names, and is classified in
`authorize.test.ts`'s coverage case as **client-reachable** — the one read capability a client
principal holds. `work.read` stays internal-only and always will: the portal serves the
projection §4 describes, not the record.

### A path of its own, not a filter on the internal one

`22-SCREEN-BY-SCREEN` §6 calls for a dedicated route, and it is a security property rather than
a routing preference. `/portal` reaches a **different service**, which builds **different
objects**, from a query that never selects an internal row. An internal endpoint that served a
client projection when asked nicely is one refactor away from serving the internal record, and
the two would share every code path that could get it wrong.

Three independent gates, and none of them is the service being careful:

1. `client_projection.read`, refused by `CapabilityGuard` before any handler runs.
2. `authorize()` per row, which for a client refuses any project outside `principal.projectIds`
   — a list that comes from `project_clients` and nothing else.
3. The audience filter, which is a **query predicate**: a client's read of `work_items` never
   selects an `internal` row, so there is no result set to be careless with.

### The projection, field by field

`25-AUTH-AND-TENANT-ISOLATION` §7: "Never implement client access as
`serializeInternalObject(); delete fields`." Every field is listed, so a column added to
`projects` or `work_items` tomorrow is invisible to a client until somebody decides it should
not be. Two omissions are the ones a filter would have got wrong:

- **No `ownerUserId`.** §4 excludes staff. Which person inside the agency is carrying a piece
  of work is an internal fact; "approved contacts" is the curated list a client is meant to see
  instead, and that is `CL-10`, unbuilt.
- **No internal `state`.** §4 gives "milestone state", not the work lifecycle. A client reading
  `internal_review` learns that their deliverable is being argued about inside the agency,
  which `26-THREAT-MODELS` treats as a disclosure. The projection says **done**, **in
  progress**, or **waiting on you** — and the last of those is the whole content of `CL-02`
  "My Actions", computed from the `client_action_required` audience rather than from a
  lifecycle the client cannot see.

The collapse is deliberately lossy: `backlog`, `ready`, `in_progress`, `blocked` and
`internal_review` all read as "in progress". A client learning that their work is blocked, and
on what, is a conversation somebody at the agency should be having rather than a status a
portal leaks.

### The client-admin invitation, without a field to get wrong

§2's "Invite client users: **within own client org/policy**" is now reachable, through
`POST /portal/client-members`. The body **cannot name a client organization** — it is taken
from the principal — so there is no field for a client admin to put a sibling client's id in,
and no code path where a check could be forgotten.

The internal `POST /invitations` keeps `org.manage`, which no client role holds, so a client
principal never reaches it. `InvitationsService` refuses the same thing independently: a client
caller must hold `client_member.manage`, the destination must be a client organization, and it
must be their own. Two places refusing the same thing, which is the intent rather than
duplication.

### The assertion parked since the HTTP surface landed is un-parked

`http-pipeline.db.test.ts` carried this since 2026-08-24:

> No such endpoint exists yet; it arrives with CLIENT-001, and this case must not be satisfied
> by granting a client role a capability the matrix withholds.

It arrived with CLIENT-002 rather than CLIENT-001 — recorded when CLIENT-001 landed rather than
left to look satisfied — and it was satisfied the way the comment insisted: a separate surface
with its own capability, `work.read` still internal-only, and the 403 in that same test still
proving it. The case itself lives in `client-002-portal.db.test.ts` under "one client cannot
see another".

### Named gaps

1. **The portal has no screens.** `CL-01` through `CL-11` are all unbuilt; `ClientPortalShell`
   exists from `WEB-001` and renders navigation to routes that do not exist. `WEB-004` is the
   ticket.
2. **`ON-03`'s client-or-internal choice still cannot be saved.** Creating a project and
   linking it to a client organization in one act is not a route; `CLIENT-001`'s sharing
   endpoint is the second step, and `ON-03` does not call it.
3. **No client requests.** `client_request.submit` is in every client ceiling and there is
   nothing to submit to — `REQ-001` is the aggregate, unbuilt. The portal reads and does not
   write.
4. **Milestones are still the project's `status`.** §4 asks for "milestone state" and there is
   no milestone table; the projection reports the project's own status and says so here rather
   than implying more.
5. **A second `InvitationsService` instance.** `ClientsModule` constructs its own, because
   `TenancyModule` provides one through `.register()` and importing it would build a second
   copy of the dynamic module. The service is stateless, so the two behave identically —
   recorded because it is a wiring choice somebody will otherwise wonder about.

---

## Verification actually run — 2026-08-26, wiring ON-04 and ID-03

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`652 s` wall (10 m 52 s), **exit 0**.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                                                                                                                        |
| `typecheck`              | Clean across five projects                                                                                                                                                                |
| `lint`                   | Clean                                                                                                                                                                                     |
| `test` (unit)            | **736 passed**, 33 files — config 25, domain 102, ui 106, api 241, **web 262**. Was 726 across 32 — one new suite of 14 cases, and four ID-03 cases moved into it from `screens.test.tsx` |
| `test:db`                | **523 passed, 21 skipped**, 18 files, **651.97 s**. Was 519 — four new preview cases                                                                                                      |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                                                                                                                     |
| `format:check` (closing) | Clean                                                                                                                                                                                     |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run                                                                                                                                 |

`next build` was run separately and succeeded: fifteen routes, unchanged.

The 21 skips are the same least-privilege cases as every previous session, and are recorded
as skips.

### The first run exited 1 on something that was not a failing test

```
Tests  262 passed (262)
Errors  1 error
```

Every assertion passed and the run was still wrong. See the section below — it is the clearest
example this project has produced of why "the suite is green" and "the code is correct" are
different sentences.

---

## ON-04 and ID-03, wired — and two roles that were not roles

`TEN-003` gave the API everything needed to admit a second person, and neither screen called
it. `ON-04` built a checked list of addresses and dropped it; `ID-03` rendered an invitation
nobody had issued. This is the half-hour that turns "the API can do it" into "a person can do
it in a browser".

Not a numbered ticket: it is the unfinished half of `WEB-001`.

### One endpoint TEN-003 did not ship

`22-SCREEN-BY-SCREEN` §3 asks `ID-03` to show the inviter, the organization, the role and the
expiry **before** the person accepts, and there was no way to ask.
`POST /v1/invitations/previews`:

- **`@Public()`** as well as `@NoTenant()`. The link arrives by email and §3's
  "account-switch option" assumes the reader may not have signed in yet. What gates the read is
  the 256-bit token, which is not enumerable; what it discloses is what the invitation was
  always going to tell the person it was sent to.
- **`POST` for a read**, token in the body, for the reason acceptance gives: a token in a query
  string is in the browser's history, in the next `Referer`, and in every access log between
  here and the client.
- **The same 404** for missing, revoked, expired and used, byte-identical apart from the
  correlation id. A preview that distinguished them would rebuild the oracle the acceptance
  path refuses to be. Asserted.

It reads through the same `bootstrapRead`, allowlisted to `invitations`, `organizations` and
`client_organizations`, joined to `users` — which needs no allowlist entry because it is in
`NON_TENANT_TABLES` and the check is about tenant-owned tables.

**`projectName` is not in the response.** `22`'s ID-03 lists one; an invitation names no
project, `0005_invitations.sql` has no column for it, and `23-ERD` §9 does not give it one. The
screen names the organization and the role and invents nothing.

### A defect ON-04 has carried since WEB-001

The screen offered three roles — `admin`, `member`, `viewer` — and **two of them are not roles
this system has**. `INTERNAL_ROLES` is `owner`, `org_admin`, `workspace_admin`, `manager`,
`moderator`, `member`, `guest`.

Nothing caught it because nothing was ever sent. The first request TEN-003 would have refused —
`requireRoleMatchesDestination`, 400 — is the one that made it visible. `lib/roles.ts` is a
`Record<InternalRole, RoleDescription>`, so a role added to `packages/domain` and not described
there is a **type error** rather than a screen that silently omits it, and it describes all
seven rather than the three `ON-04` happens to offer.

### Three decisions in the screens

- **The token is never rendered.** It arrives in `ID-03`'s route — that is where an emailed link
  puts it — goes straight into a request body, and appears in neither the document nor the URL
  beyond the path already followed. The same rule `ID-02`'s MFA challenge token follows, and a
  test asserts `container.innerHTML` and `window.location.href` for both.
- **`ON-04` posts one request per address**, sequentially, not one request for the list. A
  duplicate is a 409 and the rest should still go. Failures stay in the list so a retry does not
  re-send what worked; successes leave it. A batch endpoint would have had to invent a
  partial-success shape the API does not have.
- **Nothing emails anything, and the screen says so.** The link comes back once — the row holds
  only a hash — so it is rendered for each invitation with an instruction to send it by hand.
  A screen reading "invitations sent" would be describing a delivery that does not happen.

`ID-03` now carries an `<h1>` in **every** state, loading included. A document whose only
heading appears once a request resolves has no heading for the moment a screen reader lands on
it, and `22` §1's one-`<h1>` rule is about the document rather than about the happy path.

### A green suite standing beside an unhandled error

The first run of the chain exited 1 with a line worth keeping:

```
Tests  262 passed (262)
Errors  1 error
```

`ID-03`'s mount test in `screens.test.tsx` reused `emptyDirectoryClient`, which answers every
request with the same object — a 200 carrying the wrong shape for this screen. `Avatar` was
handed `undefined` and threw **after** the assertions had passed. Every assertion was green and
the run was a false positive.

The screen was not changed. It trusts a 200 from its own API, which is this codebase's
convention until `packages/contracts` is generated; a test feeding it a body no endpoint
returns was testing nothing. It now gets a client that answers the preview with a real one.

### Named gaps

1. **Still no mailer.** `MAIL-001` is a name this file is using for work
   `28-SPRINT-TICKETS` does not schedule; `35-NOTIFICATION-AND-EMAIL-COPY` has the copy and
   nothing renders it.
2. **Two fixtures remain on `ON-04`.** The organization's mail domain and the existing-member
   list are both invented, so the outside-domain and duplicate checks are advisory. Neither
   decides anything — the API refuses a duplicate itself, with a 409 the screen displays.
3. **`FIXTURE_INVITATION` is gone.** Nothing reads it. The fixtures file shrinks again.

---

## Verification actually run — 2026-08-26, the TEN-003 session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`647 s` wall (10 m 47 s), **exit 0**.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                                                                                                     |
| `typecheck`              | Clean across five projects                                                                                                                                             |
| `lint`                   | Clean                                                                                                                                                                  |
| `test` (unit)            | **726 passed**, 32 files — config 25, domain 102, ui 106, api 241, web 252. Unchanged                                                                                  |
| `test:db`                | **519 passed, 21 skipped**, 18 files, **646.68 s**. Was 495 across 17 — one new suite, 21 cases; the other three are the schema-drift suite growing with the new table |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                                                                                                  |
| `format:check` (closing) | Clean                                                                                                                                                                  |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run                                                                                                              |

The 21 skips are the same least-privilege cases as every previous session, and are recorded
as skips.

### The first run exited 1, on a gate the feature suite cannot reach

```
neither granted nor deliberately withheld from tmanage_app: 'invitations'
```

`users-sql.test.ts` refuses to let a table exist without a decision about the runtime
credential. All 21 invitation cases were green when it fired, because the database suite runs
as **admin** — a least-privilege deployment would have been unable to write an invitation at
all. That is ADR-0001 layer 2 covering exactly the blind spot the feature tests have.

The grant is `INSERT, UPDATE`, no `DELETE`, and the omission is stated rather than inherited.

---

## TEN-003 — how a second person gets in

Until this ticket an organization had exactly one member: whoever created it. `CLIENT-001`
could create a client organization and could not put anybody in it, because `invite` takes a
`userId` and the invitee has no account yet. `ON-04` collected addresses and dropped them.
`ID-03` rendered a fixture. Nothing in the system could admit a person who was not already in
it.

Migration `0005_invitations.sql`, one table, six routes, four audit actions.

### Accepting has no tenant context, and that is the whole difficulty

Every other write in this system runs under a `TenantContext` that `TenantContextGuard` built
from a membership row. The person following an invitation link **has no membership** — creating
one is the point of the request — so the guard has nothing to resolve, and the route carries
`@NoTenant()`.

The shape of the answer is `ProvisioningService`'s: the row itself says which organization this
is about, so the service reads it, builds a context around that organization, and runs the
whole transaction inside it. What differs from provisioning is where the organization id comes
from — there it was generated, here it is read from a row nobody signed in for. That read is
the one place this ticket touches the escape hatch, and it is fenced four ways:

- **`bootstrapRead`** — read-only, carrying a mandatory audited reason, allowlisted to
  `invitations` and nothing else.
- **A 256-bit token hash on a unique index** as the only lookup key, so the read either finds
  the one row the caller already proved they hold, or finds nothing.
- **`status = 'pending'` and `expires_at > now()` in the same `WHERE`**, so a revoked or
  overdue invitation is never returned to a branch that might mishandle it.
- **`policyVersion: 'invitation-acceptance'`** — a literal no resolved context can produce, so
  a cache keyed on it cannot collide with a real one. The same device provisioning uses.

The suite asserts what that buys, and it is the assertion this ticket is proudest of: across a
whole acceptance, **no guard event lacks an `allowedReason`**. The transaction that creates a
membership in an organization the caller was not yet in ran fully guarded.

### The token is never stored

`token_hash` holds SHA-256 of 32 CSPRNG bytes, hex-encoded. The plaintext exists in exactly one
response and thereafter only in the invitee's mailbox. A database dump, a backup, or somebody
reading the row cannot produce a working link — which is what makes `23-ERD` §9's "never
recoverable" a property of the system rather than a promise about behaviour, and why re-sending
issues a **new** token rather than re-showing the old one.

SHA-256 rather than Argon2id, and the contrast with `user_passwords` is the argument: a
password is chosen by a person, so it is low-entropy and the slow hash is what makes guessing
expensive. This is 256 bits with no structure. There is nothing to guess, and a slow hash would
only delay the person accepting.

### Single-use is a `WHERE` clause, not a check

The accepting `UPDATE` carries `status = 'pending'`. Two requests racing with one token both
find the row on the read; exactly one of them updates it, because the second one's predicate no
longer matches. The loser gets zero affected rows and raises — rather than both proceeding to
create a membership and one failing on a unique key afterwards, which would leave the
invitation accepted twice in the log.

### Every refusal is the same refusal

A token that does not exist, one that was revoked, one that expired and one already used all
produce **404 with one message**. "This invitation was revoked" would tell whoever holds a
stolen link that the address is real and that somebody noticed. `ID-002`'s sign-in path made
the same choice for the same reason; the audit trail keeps the precision the response drops.

### `expired` is a column, not `expires_at < now()`

It could have been derived, and is not. §9 makes expiry a state in the machine, and a derived
expiry would make a **revoked** invitation whose date has since passed read as "expired" —
losing the fact that a person withdrew it. Expiry is still _enforced_ by the comparison,
whether or not anything has swept; the column is bookkeeping. Both halves are asserted, and so
is the case where they disagree.

### A third defect, caught by a gate rather than by the ticket's own suite

`users-sql.test.ts` refused to let the table exist without a decision:

```
neither granted nor deliberately withheld from tmanage_app: 'invitations'
```

That is ADR-0001 layer 2 doing its job on a blind spot the feature suite cannot see. The
database suite runs as **admin**, so all 21 invitation cases were green while a
least-privilege deployment would have been unable to write an invitation at all.

The grant is `INSERT, UPDATE` and **no `DELETE`**, stated in the script rather than inherited:
an invitation is never removed, it moves to `accepted`, `revoked` or `expired`, and a runtime
credential able to delete the row could erase the grant's own history.

### Two defects the suite found, both mine

- **`metadata: { reason: ... }` was refused outright.** `reason` is in
  `FORBIDDEN_KEY_SEGMENTS` because it is where prose ends up, so `isSafeAuditMetadata` rejects
  the whole record. The key is `revocation` now and the value is one of two classifications.
  This is the **second ticket in a row** caught by that guard — WORK-001's `facts_supplied` was
  the first — which is the guard doing precisely what it exists for.
- **The bootstrap read guessed at a result shape.** It used a raw `runner.query` and
  destructured the result as mysql2's `[rows, fields]`, so every acceptance answered 404. It
  goes through Drizzle now, the way `MembershipResolver`'s own bootstrap reads do.

### Named gaps

1. **No mail is sent.** The token comes back in the response and `ON-06` is expected to build
   the link from it. There is no mailer, no template and no delivery — `35-NOTIFICATION-AND-
EMAIL-COPY` has the copy and nothing renders it.
2. **`ON-04` and `ID-03` are still not wired.** The endpoints exist; the screens do not call
   them. That is a web ticket, and it is now unblocked.
3. **A client admin cannot invite into their own client organization.** This service requires
   `org.manage`, which no client role holds, so every invitation is an internal
   administrator's act. `12-PERMISSION-MATRIX` §2 grants client admins "invite client users:
   within own client org/policy", and that narrower path is `CLIENT-002`.
4. **Expiry is swept by a route, not a job.** `POST /invitations/expirations` exists because
   `apps/worker` does not. Access is unaffected either way — the acceptance path compares
   `expires_at` in the database — but nothing sweeps on its own.
5. **The invitee's address is not checked against their account.** A person invited at
   `work@example.com` who accepts while signed in as `personal@example.com` gets the
   membership, and both facts land on the row. That is deliberate — see
   `0005_invitations.sql` — and it is a decision somebody may want to revisit with a policy.

---

## Verification actually run — 2026-08-26, the CLIENT-001 session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`597 s` wall (9 m 57 s), **exit 0**.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                              |
| `typecheck`              | Clean across five projects                                                                      |
| `lint`                   | Clean                                                                                           |
| `test` (unit)            | **726 passed**, 32 files — config 25, domain 102, ui 106, api 241, web 252. Unchanged           |
| `test:db`                | **495 passed, 21 skipped**, 17 files, **597.26 s**. Was 470 across 16 — one new suite, 25 cases |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                           |
| `format:check` (closing) | Clean                                                                                           |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run                                       |

The 21 skips are the same least-privilege cases as every previous session, and are recorded
as skips.

### Ten of the twenty-five failed on the first run, and four causes are worth keeping

Recorded because three of the four were real and one was a test that asserted the wrong thing.

1. **A client admin got 403 on their own client organization's members.** The service asked
   `authorize()` with a synthetic `internal` resource, and `authorize()` denies **any** client
   principal an internal resource — so the check refused every client admin before the scope
   rule ran. This is the exact trap `CapabilityGuard` documents at the top of its own file and
   the reason that guard stopped calling `authorize()` itself. The audience now depends on who
   is asking.
2. **`ClientsModule` could not resolve `PROJECTS_REPOSITORY`.** `ProjectsModule` provides it
   and does not export it, and both modules register through `.register()`, so importing it
   would have built a second copy of the dynamic module. The module constructs its own
   instead — a repository is stateless — and says why in place.
3. **`metadata_json` came back already parsed.** The driver returns a MySQL `JSON` column as an
   object; the test called `JSON.parse` on it. One helper now handles both, so a driver change
   cannot break the suite.
4. **A test compared two whole refusal bodies**, which include a per-request correlation id, so
   it was comparing two random uuids and would never have passed. It compares everything that
   describes _what happened_ and excludes the one field designed to differ.

---

## CLIENT-001 — the client half of the product, made reachable

The repositories landed with PROJ-001 and have been tested against a real server ever since.
Nothing could reach them: no route created a client organization, invited anybody into one, or
shared a project with one, so the entire client half of the product was storage with no door.

Thirteen routes, one new repository, nine new audit actions.

### Three sentences describe the whole ticket

1. A **client organization** is a boundary object. It has a name, and what matters about it is
   that memberships and shares hang off it.
2. A **client membership** is why a person outside the company can sign in and see anything.
3. A **`project_clients` row** is why they can see a particular project. It is the _only_
   reason: `PrincipalRepository.projectScope` reads that table and nothing else for a client,
   and `authorize()` rule 10 refuses any project outside the list it returns.

### The hardest sentence in the permission matrix

`12-PERMISSION-MATRIX` §2: "Invite client users: **within own client org/policy**."

An internal principal with `client_member.manage` manages every client of the tenant. A client
admin manages exactly their own — and getting that wrong hands one client the other's people,
which is the boundary `04-SECURITY-PRIVACY` §5 is most emphatic about. The seed world already
had two clients of the same studio, Atlas and Meridian, so the case is proved rather than
argued.

A request naming a sibling client is **refused with 404**, not filtered down to an empty list.
An empty list reads as "there is nobody there", which is a claim about a boundary this caller
must not be able to see across.

### Four decisions worth reading

- **Every write here is audited, and most work-item writes are not.** §12 lists role changes
  and publication among the events that must be recorded, and every method in this service is
  one or the other. The rule is the same one `WorkItemsService` follows — record what decides
  access — and it produces a short list there and a complete one here.
- **Archiving a client organization revokes nothing.** The audit row carries the count of
  active grants it left behind, so the archive cannot be read as an offboarding. Ending a
  relationship is two acts, and a record that implied otherwise would be false.
- **Sharing is idempotent; unsharing is recorded even when there was nothing to unshare.** A
  caller who retried a request whose response was lost should not be told the grant failed, and
  "somebody tried to revoke access that was not there" is exactly what a mistaken revoke looks
  like from the outside.
- **The audience passed to `authorize()` depends on who is asking.** A synthetic `internal`
  resource would 403 every client admin before the scope rule ran — the exact trap
  `CapabilityGuard` documents at the top of its own file, and the reason that guard stopped
  calling `authorize()` itself. The suite caught it here for the same reason it caught it
  there.

### The token is `updated_at`, and it is required

`client_organizations` and `client_memberships` have no `version` column, so the timestamp is
the concurrency token — the same position `projects` is in. It is a required field on every
write that changes an existing row, so a caller cannot opt out of optimistic concurrency by
leaving it off, and it is compared as an **instant** rather than as text: the same moment can
be written several ways and a string comparison would refuse a correct token.

A stale one is a **409**. A caller who saw a 500 would retry, and a retry with a fresh token is
the lost update the token exists to prevent.

### One request changes one thing

`PATCH /client-memberships/:id` accepts exactly one of `role`, `expiresAt` and `status`. Each
is a separate audit event describing a separate decision; a body that changed a role and
offboarded somebody at once would have to be recorded as either one lie or two events that did
not happen independently.

### Named gaps

1. **There is still no client-readable endpoint**, so the effect of a share can only be
   asserted at the row that grants it. The internal endpoints answer 403 to a client before and
   after a revoke, which proves nothing about the share. The projection endpoint is
   `CLIENT-002`, and the parked assertion in `http-pipeline.db.test.ts` waits on the same
   thing — it names `CLIENT-001`, and that expectation is corrected here rather than left to
   look satisfied.
2. **Nothing invites a client by email.** `invite` takes a `userId`, so a person must already
   exist as a user. `TEN-003`/`CLIENT-002` is the invitation flow.
3. **An expiry is enforced by the resolver, not by a job.** A grant past `expires_at` stops
   resolving, and nothing sweeps the rows or notifies anybody. That is correct for access and
   incomplete for administration — the list of "people whose access ends this month" has no
   query behind it yet.
4. **`ClientsModule` builds its own `ProjectsRepository`.** `ProjectsModule` provides
   `PROJECTS_REPOSITORY` and does not export it, and both modules are registered through
   `.register()`, so importing it would construct a second copy of the dynamic module. A
   repository is a stateless collection of queries, so a second instance costs nothing —
   recorded because it is a wiring choice somebody will otherwise wonder about.

---

## Verification actually run — 2026-08-26, the WEB-002 session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`526 s` wall (8 m 46 s), **exit 0**.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                                                          |
| `typecheck`              | Clean across five projects                                                                                                  |
| `lint`                   | Clean                                                                                                                       |
| `test` (unit)            | **726 passed**, 32 files — config 25, domain 102, ui 106, api 241, **web 252**. Was 701 across 31 — one new suite, 25 cases |
| `test:db`                | **470 passed, 21 skipped**, 16 files, **525.72 s**. Unchanged: WEB-002 adds no database surface                             |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                                                       |
| `format:check` (closing) | Clean                                                                                                                       |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run                                                                   |

`next build` was run separately and succeeded: **fifteen routes**, was twelve. The three new
ones are `/[orgSlug]/work`, `/[orgSlug]/work/[workItemId]` and
`/[orgSlug]/projects/[projectId]`, all server-rendered on demand because each reads a route
parameter or a query string.

The 21 skips are the same least-privilege cases as every previous session, and are recorded
as skips.

### A run was stopped rather than recorded

An earlier run of this chain was killed part-way through, deliberately, and is not counted
above. Mid-run it became clear that both new screens asked the work-items API for its
**default** page of 50 and rendered whatever came back — so a project with 200 items would
have shown fifty of them as though that were the work, and the project overview's counts would
have been a page's arithmetic presented as the project's.

Finishing the run would have produced a green chain describing a tree with that defect in it.
The run was stopped, the defect fixed, four cases added, and the chain above is the one that
ran against the fixed tree.

---

## WEB-002's first half — the screens that show the work

`WORK-001` gave the API six endpoints and no screen rendered one. This is the ticket that
closes that gap for the three screens `28-SPRINT-TICKETS` §4 names: `TM-03` project overview,
`TM-10` work list, `TM-13` work item detail. The ticket is marked "13→split" in the sprint
table, and this is the first half of that split.

Three screens, three routes, one API module, one presentation module, and the table styles the
application had never needed before.

### The transition form asks the machine rather than restating it

`22-SCREEN-BY-SCREEN` §5 on `TM-13`: "Transition presents only fields required for next
state."

The form asks `workItemStateMachine` two questions and renders exactly the answers:
`allowedFrom(state)` fills the select, and `requirementsFor(from, to)` decides which facts are
asked for. Nothing in `apps/web` restates §5. A transition added to the machine tomorrow
appears in this screen without the screen being edited, and the one place the lifecycle is
written stays the one place.

The server validates the same facts through the same machine, so the form is a courtesy rather
than a gate: it exists so that nobody is refused for a fact they were never asked for. A screen
that had guessed at the requirements would eventually have guessed wrong, and the refusal would
have arrived with the fields already filled in.

### A 409 is an outcome, and it is never retried

`WORK-001` made a stale write a 409. This screen shows it as what happened — somebody else
changed this first, your change was not applied, here is the item as it now stands — and
refetches.

It does not retry. A retry with a fresh version is exactly the lost update the token exists to
prevent, and doing it automatically would make the whole mechanism ornamental. The test asserts
the count: one POST, not two.

### Widening the audience is confirmed; narrowing is not

Widening names the item's **title** in the confirmation, because the title is the thing the
client will read and the moment to check it says what you meant is before it is shown, not
after.

Narrowing back to internal is sent without a confirmation. It takes something away from a
client who may already have read it, which is worth doing and is not worth a modal, because
nothing new escapes. The asymmetry is the point and both directions are asserted.

### "Health explanation" is an explanation, not a score

`22` §4 asks `TM-03` for a "health explanation". This screen gives the explanation and nothing
else: how many items are blocked, how many are past their due date, how much is finished, in a
sentence and then as counts.

There is no letter grade, no traffic light and no percentage, and that is a decision rather
than an omission. A score would be an opinion the data model has not been asked to hold, and
once a colour appears beside a project name people manage the colour rather than the work. The
counts are arithmetic anybody can repeat against the work list.

A scored indicator belongs to a later ticket and needs a stated formula before it can be drawn.

### The work list is a real `<table>`

§5 asks for keyboard row navigation, selection and sorting. Every one of those is free in a
table element and has to be rebuilt from nothing in a grid of `<div>`s — and a screen reader
announces "row 4, State, Blocked" from the first and nothing from the second. The title cell is
the row header and carries the link, so a row is reachable by Tab and openable in a new tab.

The wrapper scrolls, not the document. Seven columns do not fit a phone, and a table that
widens the page makes every other screen scroll sideways with it.

### What is deliberately not drawn

| Asked for by §5 / §4                                           | Why it is absent                                                                                                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Priority column                                                | There is no priority on `work_items` and none in `23-ERD` §5. A column reading "Normal" for every row is a fiction people would then sort by                                  |
| Blocker column                                                 | The blocker reason is a **transition fact**, not a field. There is nothing to put in the cell; the `Blocked` capsule is the part that is real                                 |
| Saved views, sorting, selection                                | The ticket's second half                                                                                                                                                      |
| Bulk actions, with policy preview                              | The second half, and the one §5 singles out for a separate confirmation — a bulk audience change can disclose a dozen items in one click, and half of that is worse than none |
| Milestones, latest internal pulse                              | Neither has storage. An empty "Milestones" heading reads as a project nobody has planned rather than a feature that does not exist                                            |
| Description, checklist, files, discussion, decisions, activity | Each its own object and its own ticket. Named once in `BackendPending` rather than drawn as empty sections                                                                    |
| Owner **names**                                                | Nothing returns a person's name. Every owner cell says "Assigned" or "Unassigned", which is the part that answers "what is this waiting on"                                   |

### Named gaps

1. **The organization's display name is still a fixture.** No endpoint returns one
   organization's profile by slug; `ID-04` fetches the whole directory. The name is invented
   once in `fixtures.ts` and the shell reads it.
2. **The work list still does not page.** It asks for the API's maximum (200) and says so
   when it gets a full one, but it does not follow the `after` cursor — that is the second
   half, alongside saved views. Caught during this session: both screens originally asked for
   the API's _default_ of 50 and rendered whatever came back, which would have shown fifty of
   two hundred items as though that were the work.
3. **The project overview's counts are a page.** Same cause and the same notice: with more
   than 200 items in one project the counts describe what was fetched, and the screen says so
   rather than presenting a page's arithmetic as the project's.
4. **The client-publication section lists what a client _would_ see.** There is no portal to
   read it in — `CLIENT-001` — and the screen says so rather than implying one exists.

---

## Verification actually run — 2026-08-26, the WORK-001 session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`645 s` wall (10 m 45 s), **exit 0**.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                              |
| `typecheck`              | Clean across five projects                                                                      |
| `lint`                   | Clean                                                                                           |
| `test` (unit)            | **701 passed**, 31 files — config 25, domain 102, ui 106, api 241, web 227. Unchanged           |
| `test:db`                | **470 passed, 21 skipped**, 16 files, **512.58 s**. Was 438 across 15 — one new suite, 32 cases |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                           |
| `format:check` (closing) | Clean                                                                                           |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run                                       |

The 21 skips are the same least-privilege cases as every previous session, and are recorded
as skips.

### The first run of this chain failed, and the failure is the point

An earlier run of the same chain exited 1 at `pnpm test`, on one case in
`packages/domain/src/policies/audit.test.ts`:

```
AssertionError: expected '§5 — a state change is what the work …' to contain '§12'
```

The clause on `work_item.transitioned` cited §5 — the state machine in `23-ERD` — where the
vocabulary test requires §12 of `04-SECURITY-PRIVACY`, which is the clause that obliges the
record to exist at all. §5 says the move is legal; §12 says it must be accounted for. The
clause now cites §12 and names §5 as the source of the move, which is what is actually true.

It is recorded because the ticket's own 32-case database suite was green when this fired: the
clause is prose, and nothing but that one vocabulary test ever reads it. A session that had
committed on the strength of the feature suite alone would have pushed a red tree.

---

## WORK-001 — the work aggregate, and four rules it had to get right

A person could sign in, create an organization and create a project, and the project was
empty. Work items are the first thing that goes in one. `work_items` was already in
`0001_tenancy.sql`, `WorkItemsRepository` was already written and `workItemStateMachine` was
already 35 tested cases in `packages/domain` — what was missing was the service, the six
routes, and the transition rules wired to the machine rather than restated beside it.

Six endpoints under `/v1/organizations/:slug/work-items`: list, read, create, update,
transition, soft delete.

### 1. State is not a field

There is no `state` on the create body or the update body. An item starts at the lifecycle's
initial state and moves only through `POST :id/transitions`, which hands the machine the
target and the facts the caller supplied.

A `PATCH` that accepted `{ state: 'done' }` would be a way around §5's requirements — an owner
and a completion time — and nothing would notice it happening. Making the transition its own
sub-resource is what makes the requirement unavoidable rather than merely documented.

The controller does not know which facts each move needs and must not learn: `packages/domain`
is the one place the lifecycle is written, and the machine's own refusal already names what
was missing.

### 2. Audience is the whole of client isolation

A client principal reads `client_visible` and `client_action_required` and nothing else. An
item outside that set answers **404**, which is the same answer an id that does not exist
gets — so the endpoint cannot be probed to discover that internal work exists.

Widening an item is audited with both sides of the change, because widening is a disclosure
decision and "who showed this to the client, and when" is the question asked afterwards.

### 3. Optimistic concurrency is a 409, not a 500

`work_items.version` is the token and the API refuses a write that names a stale one. The
first run of the suite showed the refusal escaping as a 500, because the repository's
`WorkItemVersionConflictError` was translated nowhere.

That mattered more than a wrong number: a 500 reads as a server fault, a client retries a
server fault, and a retry with a fresh version is exactly the lost update the token exists to
prevent. `writing()` now translates it at the service boundary, and the test asserts the first
writer's title is still the one stored.

### 4. A soft-deleted item reads as absent everywhere

`findById` still returns a deleted row — the repository is deliberately literal — and the list
already excluded it. `GET :id` did not, so "deleted" meant two different things depending on
how the row was reached. The service now refuses it explicitly rather than leaving it to the
`lifecycle` field in the authorization verdict.

### Two defects this ticket's own suite found

Both were fixed rather than accommodated.

- **`facts_supplied` was a comma-joined string.** `VALUE_PATTERN` in `isSafeAuditMetadata`
  forbids a comma, so every transition carrying facts became a 500 at the audit boundary —
  the write guard doing its job on its own author. It travels as an array now, which the
  metadata contract already supported.
- **`create` authorized a project id it had not proved exists.** `authorize()` was given the
  caller's own organization, so a foreign project id passed the check and reached the insert,
  where the composite foreign key refused it as a 500. Nothing crossed the tenant boundary
  either way, but the status was wrong: a scoped read now answers 404, the same as every other
  "no relation to this".

### What is recorded, and what is not

| Recorded                                      | Not recorded                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Creation, with the project and initial state  | An ordinary field edit — a title change writes no audit row                                                     |
| Every transition, with the states either side | The content of any fact — a blocker reason is prose, and §12's metadata rule is identifiers and classifications |
| Which facts were supplied                     |                                                                                                                 |
| Every audience change, with both sides        |                                                                                                                 |
| The soft delete, with the state it was in     |                                                                                                                 |

`work-001-work-items.db.test.ts` asserts the absence as well as the presence: an ordinary edit
writing an audit row would fail the suite, because an audit log that records everything is one
nobody reads.

### Named gaps

1. **`work_items.state DEFAULT 'triage'` still diverges from `23-ERD` §5's `'backlog'`.**
   Peter decided on 2026-08-25 to leave it. The service inserts an explicit `'backlog'` and
   never relies on the default, so the divergence is inert — but it is still there.
2. **The owner is not validated against the organization.** The same gap `PROJ-002` recorded:
   `owner_user_id` accepts any user id, and `PEOPLE-001` is the ticket that can check it.
3. **`type` is a free string.** `work_items.type` is `VARCHAR(32)` with no vocabulary in
   `23-ERD`, so the API bounds the length and does not invent a set of types.
4. **No pagination beyond `after` and `limit`.** The list takes a cursor and a limit and
   returns no total; a work list with saved views is `WEB-002`'s second half.

---

## Verification actually run — 2026-08-26, the PROJ-002 session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`536 s` wall (8 m 56 s), **exit 0**.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                                  |
| `typecheck`              | Clean across five projects                                                                          |
| `lint`                   | Clean                                                                                               |
| `test` (unit)            | **701 passed**, 31 files — config 25, domain 102, ui 106, api 241, **web 227**. Was 688 across 30   |
| `test:db`                | **438 passed, 21 skipped**, 15 files, **448.25 s**. Was 419 across 14 — one new suite, 19 new cases |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                               |
| `format:check` (closing) | Clean                                                                                               |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run                                           |

The 21 skips are the same least-privilege cases as every previous session, and are recorded
as skips.

---

## PROJ-002 — creating a project, and one word the specification is strict about

`PROJ-001` built the repositories and proved the tenant scoping. The create route existed and
took a name and a workspace id; `ON-03` asks for four things. This adds the other two, the
endpoint that makes the first reachable, and the audit row.

### The date is a forecast, and the column says so

`22-SCREEN-BY-SCREEN` §3, `ON-03`: "Date is marked **target** until milestone plan confirmed."

That is a schema decision expressed as a sentence, and `projects` already carried both
columns because the design language draws the same line — the pulse track separates
**committed** from **forecast** from **desired**. A date typed on a setup screen, before
anyone has planned the work, is a forecast. So:

- the request field is `targetDate`, not `dueDate` and not `deadline`;
- it lands in `forecast_at`, and `committed_at` is left null;
- the database suite asserts both columns, and the web suite asserts the request body carries
  none of the three words that would describe it as a promise.

Dates are parsed at **midnight UTC**. A calendar date interpreted in the server's local zone
means different instants on two machines and shifts by a day for anyone west of Greenwich.
`2026-02-31` is refused by round-tripping the parse, because some engines roll it into March
rather than failing.

### The workspace list exists so that a client can file something

Without it there is no way to learn a `workspaceId`, and `fk_projects_workspace_tenant` — the
composite key including `organization_id` — means one cannot be guessed. It is `work.read`
rather than `workspace.manage`, because it is a list of names needed in order to file
something rather than a management surface, and `12-PERMISSION-MATRIX` gives `work.read` to
every internal role including `guest`.

There is no create, rename or archive route beside it. The repository supports all three; a
route with no screen behind it is how an API surface grows faster than anything can exercise
it.

### Two things `ON-03` collects and still cannot save, both said on the screen

- **Client or internal.** `projects` has no audience column. A project is shared with a client
  by linking it to a client organization in `project_clients`, which is `CLIENT-001`.
- **The owner.** There is no endpoint that lists the people in an organization — `PEOPLE-001`
  — so the screen states the owner rather than offering a picker. A select with one invented
  name in it would look like a choice and be a fiction. The API defaults the owner to whoever
  created the project, because a project with no owner is one nothing can be escalated to.

### The onboarding sequence moved under the organization

`ON-02`, `ON-03` and `ON-04` are now at `/[orgSlug]/onboarding/...`. `ON-01` stays at
`/onboarding/organization`, because it creates the organization and there is no slug to be
under; it hands off to `/[slug]/onboarding/template`.

A slug in a URL is safe and the two comments in the code say why: it is public, it is in every
link a customer sends, and holding it grants nothing — the API's `TenantContextGuard` resolves
it against a membership row before any handler runs. That is the exact opposite of the MFA
challenge token, which is deliberately kept out of URLs.

### Named gaps — PROJ-002

1. **The owner is not validated against the organization.** `fk_projects_owner` references
   `users (id)` without `organization_id`, because a user is not tenant-owned — so a caller
   who knows another organization's user id could name them as owner of a project here. The
   screen cannot do it (it sends no owner at all), but the endpoint would accept it. Closing
   it needs a membership read that belongs with `PEOPLE-001`.
2. **No outbox event.** The transaction is the right one and `PLAT-004`'s relay is still not
   written, so `project.created` is audited and not published.
3. **`committed_at` is never written by anything.** It becomes writable when a milestone plan
   can be confirmed, which is `WORK-002`/`MILE-001`.
4. **`ON-02`'s operating template still saves nothing.** There is no column for it.
5. **No project update or archive route.** The repository has both, with optimistic
   concurrency on `updated_at`; the screens that would call them are `WEB-002`.
6. **A project has no members yet.** `ProjectMembershipsService` exists and is audited, and
   nothing routes to it — so a project created here is visible to org-wide roles and to nobody
   else.

---

## Verification actually run — 2026-08-26, the TEN-001 session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`496 s` wall (8 m 16 s), **exit 0**.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                                     |
| `typecheck`              | Clean across five projects                                                                             |
| `lint`                   | Clean                                                                                                  |
| `test` (unit)            | **688 passed**, 30 files — config 25, domain 102, ui 106, api 241, **web 214**. Was 675 across 29      |
| `test:db`                | **419 passed, 21 skipped**, 14 files, **410.67 s**. Was 393 across 13 — one new suite and 26 new cases |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                                  |
| `format:check` (closing) | Clean                                                                                                  |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run                                              |

The 21 skips are the same least-privilege cases as every previous session, and are recorded
as skips.

---

## TEN-001's second half — provisioning, and the wrong inference it corrects

This gap note has been in this file since TEN-001 first landed:

> **Organization creation is not implemented.** Provisioning happens before any membership
> exists, so it cannot run under a `TenantContext`, and the bootstrap path is read-only by
> construction.

The first clause is true. **The second does not follow**, and that is the finding of this
session rather than a detail of it.

A `TenantContext` is not a permission the database grants. It is a declaration of which
organization every statement on this connection may touch, which the tenant guard then
enforces — and nothing about that requires the organization to already exist.
`ProvisioningService` generates the organization's id and the founding membership's id
**first**, builds a context from them, and runs the whole transaction inside it.

The result is **narrower** than every other write path in this system, not wider:

- Every statement is anchored to an organization id that nothing else in the database
  references yet. A statement with a forgotten predicate could not reach another tenant's
  rows, because there are no other rows with that key.
- `OrganizationsRepository.create` and `MembershipsRepository.createFounder` each refuse an id
  that is not the one their context names, so the two cannot drift apart.
- `bootstrapRead` — the actual hole in the guard — is not used by provisioning at all.

The suite asserts it directly: the guard runs in `enforce` mode throughout a provisioning
call and reports **no violation**.

### What the transaction does, and why it is one transaction

Organization, first workspace, founding owner membership, and the audit row — together, or
not at all. An organization with no membership is one nobody can administer, reach or delete;
it holds a slug forever and is invisible to every screen, because every screen reaches
organizations through memberships. A taken slug rolls all of it back, asserted by counting
memberships before and after.

The proof that it worked is not that rows exist. It is that `MembershipResolver` — the real
`25-AUTHORIZATION-AND-TENANT-ISOLATION` §3 step 2 — resolves the new organization for the
founder on the very next call, with the owner's full capability set and a real `policyVersion`
that has replaced the literal `provisioning` the transaction ran under.

### `createFounder` is a separate method, so the exception stays countable

`invite()` writes `status: 'invited'`, and that distinction is worth having everywhere except
here: the person creating the organization _is_ the person being granted, and an invitation
they would have to accept from themselves is ceremony rather than a control. Making it a flag
on `invite()` would have hidden the exception; a separate method means there is exactly one
call site and a second one is a diff.

### The directory is the second unscoped read in this system, and that is a cost

`MembershipResolver` was the first: it answers "may this session act in _this named_
organization", which is the read that establishes a tenant and cannot be inside one.
`OrganizationDirectoryRepository` answers "which organizations may this session act in at
all", which spans tenants by definition.

What makes it acceptable is a property the resolver does not have: **it takes no
caller-supplied identifier**. The only input is the `userId` from a verified session, and the
predicate is `memberships.user_id = ?`. There is no parameter an attacker could vary, because
the one parameter is who they already are. That is why the repository exposes exactly one
method — a second one taking any other identifier would not inherit the argument.

It returns no cross-organization aggregate, and could not: `work_items` is not in its declared
table list, so the guard would refuse the read. `22-SCREEN-BY-SCREEN` §3's "no
cross-organization aggregated content in MVP" is therefore enforced by the guard as well as by
the screen, and both are asserted.

### Two findings from the first run, both real

1. **Drizzle wraps driver errors, and the unwrapping happens too late for this case.**
   `unwrapQueryError` strips `DrizzleQueryError` at the transaction boundary in
   `TenantDatabase`. This is the first code in the repository that has to react to a driver
   error _inside_ the transaction — a duplicate slug — so it read the wrapper's `code` rather
   than the cause's, and a genuine collision arrived at the caller as a 500.
2. **The audit metadata rule refused camelCase keys.** `isSafeAuditMetadata` requires
   snake_case, because `metadata_json` is queried with hand-written JSON path expressions and
   two spellings of one key make a query that silently misses half the rows. The write
   boundary caught it, which is what it is for.

### One decision worth stating: the server does not lower-case a slug

The browser derives a lowercase address, but a slug posted directly with capitals is
**refused** rather than silently folded. The slug is the most visible string this product has
— it is in every link a customer will send — and a person should get the address they saw
confirmed rather than a transformation they did not ask for.

### Named gaps — TEN-001's second half

1. **`ID-04` shows no project count.** The export's row carries one. Counting projects per
   organization needs `projects` in the directory's declared table list, which widens an
   unscoped read to a tenant-owned content table. Not bought at that price.
2. **"Last opened" is not recorded.** `22` §3 asks for it; nothing writes it, and the control
   on the screen says so rather than being absent.
3. **The founder is the only member.** `ON-04` collects invitations and cannot send them —
   `TEN-003` is still the storage half only.
4. **Slug changes are still not implemented**, and this gap is unchanged: the slug is in every
   bookmarked URL and every link already sent to a client, and whether the old one is reserved
   or reusable is a product question the pack does not answer.
5. **A Workspace Admin still does not get organization-wide scope by default.** Unchanged;
   closing it needs a workspace-scope column and a migration.
6. **`policyVersion` is still derived rather than stored.** Unchanged. Provisioning adds one
   wrinkle worth naming: its context carries the literal `provisioning`, which no resolved
   context can produce, so a cache keyed on it cannot collide with a real entry.
7. **Nothing deletes or archives an organization through an endpoint.** The repository has
   `archive()`; no route calls it, and the directory already excludes archived rows.
8. **`ON-02` and `ON-03` still save nothing.** The operating template has no column to live in,
   and project creation is `PROJ-002`. Both still say so on the screen.
9. **The reserved-slug list is a judgement, not a specification.** The pack names no reserved
   slugs. The list is short and additive, and a slug that becomes reserved later stays owned by
   whoever holds it — evicting a customer would be worse than the collision it prevented.

---

## Verification actually run — 2026-08-26, the ID-002 session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`418 s` wall (6 m 58 s), **exit 0**.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                                                        |
| `typecheck`              | Clean across five projects                                                                                                |
| `lint`                   | Clean                                                                                                                     |
| `test` (unit)            | **675 passed**, 29 files — config 25, domain 102, ui 106, **api 241**, **web 201**. Was 531 across 24 before this session |
| `test:db`                | **393 passed, 21 skipped**, 13 files, **337.65 s**. Was 324 across 11 — two new suites and 69 new cases                   |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                                                     |
| `format:check` (closing) | Clean                                                                                                                     |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run                                                                 |

The 21 skips are the same least-privilege cases as every previous session. They skip on the
default per-file path and were run to 0 skips on 2026-08-25 against MySQL 8.0.45 and MariaDB
11.4.5. They are skips, and they are recorded as skips.

### What the 213 new cases are worth

| Check                        | What it proves                                                                                                     | What it does not                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 52 TOTP cases                | Every published RFC 4226 and RFC 6238 test vector, the drift window, and replay refusal                            | That a real authenticator app agrees — no phone has been paired              |
| 35 password cases            | Argon2id round-trip, the PHC parameters, rehash detection, Unicode normalisation, and every screening rule         | That the bundled list resembles a real breach corpus                         |
| 23 recovery-code cases       | 50 bits, no confusable characters, single-use attribution, and every accepted spelling of one code                 | Nothing about storage — that is the database suite                           |
| 20 challenge-token cases     | Signature, purpose binding, expiry order, tamper refusal, and that the Argon2 constants match `packages/config`    | That five minutes is the right window                                        |
| 37 credential database cases | One answer for three causes, the enumeration trace, the lockout, TOTP replay, and recovery codes under a race      | Anything about HTTP                                                          |
| 20 auth HTTP cases           | The refusal is **byte-identical**, a real session comes out, and the enrolment routes act only on their own user   | That a browser behaves the same — `app.inject()` is Fastify without a socket |
| 26 web cases (net +14)       | The screen posts what it should, renders the API's own refusal, and never puts the challenge token in the document | Anything a real browser renders                                              |

---

## ID-002 — what actually proves a person is who they say they are

`SessionService.start()` has taken a `userId` "established by whatever proved the person's
identity" since ID-001 landed. This is that whatever, and the two stay separate: this decides
_whether_ a person is authenticated, `SessionService` decides what a session _is_.

**A person can now sign in.** That sentence has not been true of this codebase before.

### The one rule the whole ticket is arranged around

**Every failure looks the same from outside.**

An unknown email address, an address with no password set, a wrong password, a wrong TOTP
code, a replayed code, an expired challenge and a spent recovery code are seven rows in
`authentication_events` and **one** answer to the caller. `id-002-auth-http.db.test.ts`
asserts it by comparing whole response bodies with the correlation id masked — a status-only
assertion would pass while the body gave the game away.

That is not enough on its own, and the second half is the part that is easy to skip. An
unknown email would return in a millisecond while a wrong password took the 15 ms an Argon2
verify costs, and that difference is measurable over a few hundred requests. So the
unknown-user path **runs a verify anyway**, against a hash of a value nobody knows. The work
is wasted deliberately.

The one deliberate exception is a lockout: 429 rather than 401. It does tell an attacker the
account exists, and `22-SCREEN-BY-SCREEN` §3's `ID-02` specifies a rate-limited state on the
screen — a person who has locked themselves out needs to know that waiting is the fix rather
than being sent round the password loop again.

### What is built, and what each piece costs

| Piece                | Decision                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Passwords**        | Argon2id at OWASP's first recommended configuration — m = 19 MiB, t = 2, p = 1. Measured at **15 ms** on this machine |
| **Second factor**    | TOTP, RFC 6238, verified against every published vector before anything was written on top of it                      |
| **Recovery codes**   | Ten codes of 50 bits, Crockford's alphabet, SHA-256 at rest, individually single-use                                  |
| **The challenge**    | A signed, purpose-bound, five-minute token. Stateless                                                                 |
| **The lockout**      | A `COUNT(*)` over `authentication_events` inside a window                                                             |
| **The security log** | `authentication_events` — append-only by trigger **and** by grant, non-tenant                                         |

Each of those has a reason that is worth stating once rather than being inferred:

- **19 MiB rather than 64.** `50-BOOTSTRAP` targets a shared host, where a sign-in burst
  allocating 64 MiB per concurrent hash exhausts the plan's memory long before an attacker's.
- **The PHC string carries its own parameters**, so raising the cost later invalidates no
  credential. `needsRehash` notices on the next successful sign-in, which is the one moment
  the plaintext is legitimately in memory.
- **No composition rules.** NIST 800-63B removed them deliberately and they are why
  `Password1!` exists. Length is counted in code points, so eight emoji is eight characters.
- **SHA-1 for TOTP**, and that is not a judgement about the hash. Essentially every
  authenticator application ignores the `algorithm` parameter in the `otpauth://` URI and
  assumes SHA-1; choosing SHA-256 produces codes that silently do not match on most phones.
- **`verifyTotp` returns the counter it matched**, not a boolean, because a code stays valid
  for up to 90 seconds with the drift window and one observed over a shoulder is otherwise
  replayable for all of it. Every candidate in the window is checked even after a match, so
  the running time does not leak how far the presenter's clock is from the server's.
- **Recovery codes are SHA-256, not Argon2id**, and that is deliberate rather than an
  inconsistency. They are 50 bits of randomness with no dictionary to run against them, and
  ten Argon2 verifications per attempt on a pre-authentication endpoint is a denial-of-service
  amplifier with a factor of ten built in.
- **The Argon2 verify runs outside any transaction.** Inside one it would pin a pooled
  connection for 15 ms on every sign-in attempt, which is the cheapest way to turn a password
  endpoint into connection-pool exhaustion.

### The gap this closes, and the table it closes it with

`docs/implementation-status.md` has carried this since the HTTP surface landed:

> Denials before tenant resolution (no session, bad CSRF, unresolvable org) leave no audit
> row, because `audit_events.organization_id` is NOT NULL with a foreign key.

A failed sign-in is the sharpest case of it, and it cannot go in `audit_events`:
authentication happens **before any tenant exists**, and an attempt that names an address no
account holds names no user either. Rather than loosening a NOT NULL on an append-only table
so that half its rows answer a different question from the other half, identity gets its own
append-only log beside the other non-tenant identity tables.

That row — `user_id NULL`, `reason = 'no_such_user'` — is the only trace an enumeration sweep
leaves anywhere in the system. It is asserted.

The gap is **narrowed, not closed**: a bad CSRF token and an unresolvable organization slug
still leave no row, because those denials happen in the HTTP guards rather than in this
service. That remains open.

### Four tables, and why not three columns on `users`

- A person may hold **several** second factors — a phone, a tablet, later a passkey — and a
  column holds one.
- Recovery codes are **individually single-use**. A JSON blob of ten would have to be
  rewritten to spend one, and two concurrent spends of different codes would race and lose
  one. A row per code makes spending an `UPDATE … WHERE used_at IS NULL` that the database
  serialises. Asserted with two simultaneous attempts on the same code: exactly one succeeds.
- `users` is read on paths that have nothing to do with authentication. A password hash in
  that row is a password hash in every `SELECT *`, every log line that dumps a user, and every
  future projection built from it.

### One finding, from the suite's own first run

The ID-002 database suite failed on its first run — not on an assertion, but in `beforeEach`:

```
authentication_events is append-only: rows cannot be deleted
```

The append-only trigger fired on the test's own cleanup, under the **migrator** credential.
That is the guarantee working on its author. The suite now clears the table with `TRUNCATE`,
which is DDL and does not fire row triggers; the trigger was not weakened for the suite's
convenience.

### Named gaps — ID-002

1. **Passkeys are not built**, and the reason is not preference. WebAuthn registration needs
   a browser and an authenticator; this machine has neither, and a server-side verifier that
   has never seen a real attestation is not evidence of anything. `04-SECURITY-PRIVACY` §3
   lists passkeys first, and TOTP is the weaker credential — it has a shared secret the
   server must store recoverably, which a WebAuthn public key does not.
2. **SSO and SAML are not built.** Same shape of reason: no identity provider exists here.
3. **Breached-password screening is a bundled list, not a corpus.** §3 asks for real
   screening; HIBP's k-anonymity range API is the way to do it and is a network call to a
   third party this machine has never made. `BreachedPasswordScreen` exists so the call slots
   in without changing a caller, and its `undefined` return distinguishes "could not check"
   from "not breached" — a remote screen that fails open silently is worse than none.
4. **Email verification is not wired.** `users.email_verified_at` has existed since 0001 and
   nothing sets it. Sign-in does not require it, which means an unverified address can hold a
   password. Closing it needs the notification surface.
5. **Password recovery is not built.** `ID-05`'s four recovery states are still inert: a
   reset link needs email, which needs the notification surface.
6. **The lockout is per user, not per source.** It stops credential stuffing against one
   account and does nothing about one attempt each against a thousand accounts.
   `13-ENGINEERING-EXECUTION-SPEC` §1 assumes Redis; there is none here and none on the
   shared host.
7. **The lockout window is a counter, not a lock.** Two attempts arriving together can both
   read a count below the threshold. Closing it would need `SELECT … FOR UPDATE` on a row that
   does not exist yet; the attacker's gain from the race is one extra guess.
8. **The challenge token is replayable inside its five-minute window.** It is stateless by
   choice — the alternative is a table and a sweeper on the hottest unauthenticated path —
   and it is not a credential on its own: presenting it earns the right to be asked for a
   code, and `last_accepted_counter` refuses a replayed one.
9. **Nothing revokes sessions when a password changes.** Changing a password should end every
   other session; `SessionService.revokeAllForUser` exists and is not called from here.
10. **No `trust this device` duration**, which `22` §3 lists for `ID-02`. It needs a device
    identifier the session does not carry.
11. **TOTP secrets are stored recoverably.** They must be — the algorithm needs the secret to
    compute the same code — so a database disclosure hands the reader every second factor.
    That is the argument for passkeys, and it is the reason gap 1 matters more than its
    position suggests.
12. **No admin-assisted verification**, the third fallback the export's `ID-02` draws.
13. **Sign-in emits no analytics.** `34-ANALYTICS` defines `sign_in_started` / `succeeded` /
    `failed`; there is no telemetry transport.
14. **Nobody has signed in through a browser.** Every path is proved by `app.inject()` and by
    jsdom. No human has typed a password into this application.

---

## Planning-pack reconciliation — re-verified 2026-08-26, start of the WEB-001 session

The tenth verification, and the tenth identical result. Both trees were compared by SHA-256,
file by file, and modification times were compared **pair by pair** rather than
newest-against-newest.

| Tree                                                       | Result                                             |
| ---------------------------------------------------------- | -------------------------------------------------- |
| `outputs/TManage-Planning-Pack/` (root) → `docs/planning/` | **61/61 byte-identical**, 0 differing, 0 missing   |
| Pack's design handoff subtree → `docs/design/source/`      | **147/147 byte-identical**, 0 differing, 0 missing |
| Any pack file newer than its repository copy               | **None**, in either tree                           |
| Repository files with no pack counterpart                  | **None**, in either tree                           |

The only pack files that are deliberately not copied remain the design-handoff `.zip` (it is
extracted into `docs/design/source/`), the `.docx` of the master plan, and three Claude Code
tooling files (`CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json`).

The pack's own `tmanage/`, `graphify-out/` and design-handoff subtrees are filtered out of the
comparison. They are not planning files, and including them produces a false "10 differing"
result that has been mistaken for real drift before.

---

## Verification actually run — 2026-08-26, the WEB-001 session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`350 s` wall (5 m 50 s), **exit 0**.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `format:check` (opening) | Clean. Run **after** `pnpm format` — Prettier reformatted 19 of the new files, and recording a green run before that would have been recording a run that never happened |
| `typecheck`              | Clean across five projects: `packages/config`, `packages/domain`, `packages/ui`, `apps/api`, **`apps/web`**                                                              |
| `lint`                   | Clean. 48 files in `apps/web` alone                                                                                                                                      |
| `test` (unit)            | **531 passed**, 24 files — domain 102, config 25, ui 106, api 111, **web 187**. Was 344 before this session                                                              |
| `test:db`                | **324 passed, 21 skipped**, 11 files, **276.19 s**. Unchanged: WEB-001 adds no database surface                                                                          |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                                                                                                    |
| `format:check` (closing) | Clean                                                                                                                                                                    |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run; nothing was left behind                                                                                       |

The 21 skips are the same least-privilege cases as before. They skip on the default per-file
path and were run to 0 skips on 2026-08-25 against MySQL 8.0.45 and MariaDB 11.4.5. They are
skips, and they are recorded as skips.

### One check that is deliberately not in the chain

`next build` is **not** part of `pnpm test` and was not added to it. It was run separately,
twice, and succeeded both times — Next.js 16.3.3, Turbopack, TypeScript clean, twelve routes
generated (the eleven screens plus `_not-found`, of which three are server-rendered on demand
because they read a route param or a query string).

It is left out of the chain because it would add roughly twenty seconds to every run to prove
something `typecheck` and `lint` already prove for the code, and because a build artifact is
not evidence about behaviour. When there is a deployment it becomes a deploy-time gate, which
is where a build belongs.

### What the 187 new cases are worth

| Check                 | What it proves                                                                                                                                     | What it does not                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 18 API-client cases   | Credentials, the CSRF header on unsafe methods only, the correlation id, and every shape of malformed refusal, against a `fetch` the test supplies | That the API agrees — no request in these tests leaves the process                     |
| 21 slug cases         | The workspace address is derivable, bounded at the column width, and never ends in a hyphen even when truncated                                    | That any particular slug is available                                                  |
| 25 invitation cases   | Duplicates, existing members and outside domains are all caught, case-insensitively, in list order                                                 | That an invitation would be accepted                                                   |
| 19 shell cases        | Landmarks, skip link, one `<h1>`, `aria-current`, and that the portal shell can render no internal destination                                     | Anything visual                                                                        |
| 69 screen cases       | Every screen's specification rules, plus axe over all nine with the `region` rule **enabled**                                                      | Colour contrast — jsdom does not paint, so that rule stays off and is computed instead |
| 11 session-flow cases | The two screens that talk to the API do so correctly, including the failure paths                                                                  | That the API answers this way — the responses are constructed by the test              |
| 24 contrast cases     | Every pairing this application introduces, computed with WCAG 2.2 arithmetic, plus two structural rules on the stylesheet                          | What a browser renders                                                                 |

### The lint boundaries were verified to fire, not merely to pass

One deliberate violation was written, run, and deleted — a `.ts` probe in `apps/web` importing
`@tmanage/api`, importing `mysql2`, and reading `localStorage`. All three rules fired:

- `'@tmanage/api' import is restricted … never on API internals (18-REPOSITORY-STRUCTURE)`
- `'mysql2' import is restricted … Infrastructure clients never belong in the web app`
- `Browser storage is never authoritative business state (15-AI-EXECUTION-HANDBOOK §8)`

A boundary that has only ever passed has not been tested.

---

## WEB-001 — the application, its two shells, and nine screens

`apps/web` was an empty directory. It is now a Next.js 16.3.3 App Router application with
React 19 and TanStack Query, and it holds the nine screens `22-SCREEN-BY-SCREEN-SPEC` §3
numbers ID-01 to ON-04.

### The rule the whole ticket is built on

**No screen simulates a server it does not have.**

Nine screens were built against an API that can currently do two things for these screens:
list a person's sessions, and end the current one. Everything else — passwords, passkeys, MFA,
invitations, organization creation, project creation — is a later ticket.

A screen could hide that with a fake delay and a canned success. None of them do:

- Every control whose endpoint is unwritten is `disabled`.
- Every screen in that position renders a `BackendPending` notice naming the ticket that
  closes it — ID-002, TEN-001, TEN-003, PROJ-002.
- Every invented value lives in `src/lib/fixtures.ts`, one file, so the extent of what is not
  connected is countable rather than scattered.

| Screen                      | Route                      | What is real                                                                     |
| --------------------------- | -------------------------- | -------------------------------------------------------------------------------- |
| ID-01 Sign in               | `/sign-in`                 | The development-only sign-in, fenced in a labelled panel. Nothing else           |
| ID-02 MFA challenge         | `/sign-in/verify`          | Shape validation of the code, and nothing beyond it                              |
| ID-03 Invitation acceptance | `/invitations/[token]`     | Nothing. The token is not even echoed into the page — it is a credential         |
| ID-04 Organization selector | `/organizations`           | The in-browser filter. The list is a fixture                                     |
| ID-05 Sessions and devices  | `/sessions`                | **All of it.** `GET /v1/sessions/current/devices`, `DELETE /v1/sessions/current` |
| ID-05 Recovery, four states | `/recover?state=`          | Nothing. The four states are rendered as four states                             |
| ON-01 Create organization   | `/onboarding/organization` | Slug derivation and validation. Nothing is saved                                 |
| ON-02 Operating template    | `/onboarding/template`     | The workflow preview, generated from `@tmanage/domain`'s real state machines     |
| ON-03 First project         | `/onboarding/project`      | Date validation. Nothing is created                                              |
| ON-04 Invite team           | `/onboarding/team`         | Every duplicate, member and domain check. Nothing is sent                        |

### The two shells are two components, and that is a tenancy decision

`22-SCREEN-BY-SCREEN` §1 defines an internal shell and a client shell. `AppShell` and
`ClientPortalShell` are separate components rather than one with an `audience` flag.

The reason is not styling. `12-PERMISSION-MATRIX` and `25-AUTHORIZATION-AND-TENANT-ISOLATION`
mean a client sees a _different_ space, not a reduced one. Built as one component with items
filtered out, every internal destination added in future would be one forgotten filter away
from appearing in a client's portal. Built as two, `CLIENT_NAVIGATION` is the only list the
portal shell is capable of rendering. `tests/shells.test.tsx` asserts that every portal link
starts with `/portal` and that no internal destination appears among them.

Two more shells exist for the screens that have no tenant yet: `IdentityShell` (ID-01 to
ID-05, which have no organization because `ID-04` is where one is chosen) and
`OnboardingShell` (the four-step sequence). Both own the skip link, the `<main>` landmark and
the single `<h1>`, so `A11Y-01` is satisfied structurally rather than nine times by hand.

### Three findings, each asserted rather than commented

1. **`--ink-500` cannot be used for text on this application's surfaces.** Measured: 4.51:1 on
   `--paper-0`, 4.20:1 on `--paper-50`, 3.70:1 on `--paper-150`. Only the first clears the AA
   floor, and it clears it by 0.01. Secondary text throughout `globals.css` is `--ink-650`,
   which is 6.74:1 at its worst. `tests/contrast.test.ts` asserts all three numbers and also
   greps the stylesheet to prove `--ink-500` sets no colour, so a later edit reaching for it
   has to argue with a failing test.

2. **`--line-700` inverts in the dark theme.** It is `#2C2E29` under `:root` and `#F5F6F0`
   under `[data-theme='dark']` — an _ink_ token that happens to be dark in the light theme.
   The identity backdrop, the orbital rail and the portal header all need a dark surface in
   **both** themes, so painting them with `--line-700` would have produced a white slab with
   white text on it in dark mode. Four semantic properties (`--tm-inverted-*`) resolve to the
   right token per theme instead, and a test asserts each one is defined under both.

3. **An `input[type="email"]` blocks its own form's submit.** ON-04's inline duplicate,
   existing-member and outside-domain checks are the entire point of that screen, and they
   would never have run: the browser's own constraint validation refuses the submit first and
   shows a native bubble, which cannot be styled, is not associated with the field for a
   screen reader, and vanishes on the next click. Found by a test that failed. The form is
   `noValidate` and says why in a comment.

### The typeface question is settled, on licence rather than taste — ADR-0005

The design export disagreed with itself: `tokens.json` and `tokens.css` name **Manrope**,
while every rendered `.dc.html` artboard sets `font-family: Satoshi, Manrope, system-ui` and
uses **both** — Satoshi for headings and controls, Manrope for prose. It was a two-typeface
pairing the token file does not describe, and it was left open at the end of UI-001.

It is not a matter of preference. `uploads/Satoshi_Complete/License/FFL.txt` is the Fontshare
EULA, and §02 reads:

> "You are not allowed to transmit the Font Software over the Internet in font serving or for
> font replacement … without the prior written consent of the Licensor."

A `@font-face` served from our own origin is font serving over the Internet. Satoshi could
never have been self-hosted here, so the question had a legal answer before it had a design
one. Manrope ships under the SIL OFL 1.1, its licence file travels beside the binary in
`apps/web/src/fonts/`, and the packaged file is a byte-identical copy of the export's
(SHA-256 `2b7a1ebc…8c77cd`). This also matches `--font-latin`, which already said Manrope and
is pinned to the export by `tokens.drift.test.ts`.

**If Peter wants Satoshi, it needs written consent from the Indian Type Foundry**, and it
would then also require changing a token the drift test holds against immutable source
material. That is the real cost of a reversal and it is recorded in the ADR.

### Named gaps — WEB-001

These are open, recorded rather than hidden, and none of them should be closed by guessing.

1. **Four of the ten screen states have no server.** This line read "nine" when WEB-001
   landed, "seven" after ID-002 connected `ID-01` and `ID-02`, "five" after TEN-001's second
   half connected `ID-04` and `ON-01`, and four now that PROJ-002 connected `ON-03`. What
   remains — the invitation, recovery, the operating template, and the team invitations —
   still says so on the screen with the ticket that closes each one.
2. **The sessions list cannot mark "this device".** The API's `SessionSummary` has five
   fields and `current` is not among them. Guessing from the user agent would be wrong the
   moment two tabs hold two sessions, so the rows are unmarked.
3. **Revoking one _other_ session has no route.** `SessionService.revoke()` is only ever
   called with the caller's own session id. The per-row control is present and disabled.
4. **No analytics.** `34-ANALYTICS` defines `sign_in_started` / `succeeded` / `failed`; there
   is no telemetry transport, and firing them into a console is not instrumentation. Nothing
   is emitted.
5. **No Content-Security-Policy.** The other four security headers are set in
   `next.config.ts`. A CSP written before the application has its final asset origins is a
   CSP that gets loosened once and never tightened again.
6. **No visual-regression harness, still.** Carried from UI-001 and now larger, because there
   are screens to regress. It needs a real browser or a paid service; neither exists here.
7. **The contrast checks remain arithmetic.** They cannot prove what a browser renders.
8. **Arabic is unreachable.** `dir` is `ltr` on `<html>`, and the Arabic face the tokens name
   (Alexandria) is not in the export at all — the artboards load it from Google Fonts. Every
   offset in `globals.css` is a logical property and a test enforces that, so the switch is a
   value change rather than a rewrite, but it has never been rendered.
9. **Geist Mono is not packaged either**, for the same reason. Monospaced text falls back to
   the platform's face, which changes the eyebrow metrics but not their meaning.
10. **The font ships as `.ttf`, not `.woff2`.** Roughly 120 KB of avoidable transfer. No
    conversion tool is installed here and re-encoding a binary the repository received rather
    than produced is not something to do casually. A build step, not a decision.
11. **The API error envelope is duplicated by hand** in `src/lib/api/errors.ts`, because
    `apps/web` may not import `@tmanage/api` and `packages/contracts` is still an empty
    directory. The duplication is small and visible; CONTRACT-001 removes it.
12. **Screen-id divergence between the specification and the export.** The export's
    onboarding artboards open with a "what do you deliver" step and insert a milestones step,
    so its `ON-04` is the specification's `ON-03`. The specification's ids are used, because
    tickets, the traceability matrix and the test catalog all cite them; the export's
    composition is used, per `40-DESIGN-SYSTEM` §1. Neither document was edited.
13. **`project_memberships.role` is still unconstrained** at the database. `ON-04` offers
    three roles from a fixed list, which is now the only thing keeping a typo out of that
    column from this screen. That is a reason to close the database gap, not a substitute.
14. **Nothing has been rendered in a real browser.** The screens have been compiled, built,
    and mounted in jsdom. No one has looked at them.

---

## Verification actually run — 2026-08-26, the UI-001 session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`5m 22s` wall, **exit 0**.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`, because Prettier reformats every new file                      |
| `typecheck`              | Clean across `packages/config`, `packages/domain`, `packages/ui`, `apps/api`                       |
| `lint`                   | Clean, including the two new rule groups                                                           |
| `test` (unit)            | **344 passed**, 17 files — domain 102, config 25, **ui 106**, api 111. Was 238 before this session |
| `test:db`                | **324 passed, 21 skipped**, 11 files, **274.24 s**. Unchanged: UI-001 adds no database surface     |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                              |
| `format:check` (closing) | Clean                                                                                              |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run; nothing was left behind                 |

The 21 skips are the same least-privilege cases as before — they skip on the default per-file
path and were run to 0 skips on 2026-08-25 against MySQL 8.0.45 and MariaDB 11.4.5. They are
skips, and they are recorded as skips.

### Checks that are new this session, and what each one is worth

| Check                                    | What it proves                                                                                                                                     | What it does not                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 14 token-drift cases                     | The package agrees with the design export in both directions, value by value                                                                       | That the export is right                                                     |
| 33 contrast cases                        | Every pairing the primitives paint meets AA, computed with WCAG 2.2 arithmetic                                                                     | What a browser actually renders — no layout, no overlay, no inherited colour |
| 59 component and theme cases             | Names, roles, keyboard reachability, `aria-busy`, description order, and axe over the whole primitive surface in four theme/direction combinations | Anything visual                                                              |
| `storybook build` + three driven stories | The stories compile, render, and receive the toolbar globals                                                                                       | Visual regression — there is no baseline and no browser to take one with     |

### The lint boundaries were verified to fire, not merely to pass

Two deliberate violations were written, run, and deleted:

- a `.tsx` probe with an `<img>` with no `alt` and a `<div onClick>` — three `jsx-a11y` errors
  (`alt-text`, `click-events-have-key-events`, `no-static-element-interactions`);
- a `.ts` probe importing `@tmanage/domain` from `packages/ui` — the design-system boundary
  error.

A boundary that has only ever passed has not been tested.

### One defect the harness found in its own first run

Three `Field` assertions failed on the first run, and all three were the test being wrong
rather than the component. The `aria-hidden` required-asterisk is excluded from the accessible
description, and the label's _text_ is "Title \*" while its _name_ is "Title" — so the query had
to be by role and accessible name, which is the property actually worth asserting. The
expectations were corrected; nothing in the component was relaxed to make them pass.

---

## Verification actually run — 2026-08-26, the AUD-001 session

The full chain, on the default local path (embedded MySQL 8.0.45, admin credential). Run
**after** `pnpm format`, because Prettier reformats new files and recording a green
`format:check` that only passed because it was never run against the new code would be a
false claim.

```
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db &&
pnpm audit:design && pnpm format:check
```

| Gate                    | Result                                                   |
| ----------------------- | -------------------------------------------------------- |
| `format:check` (before) | clean                                                    |
| `typecheck`             | clean — `packages/config`, `packages/domain`, `apps/api` |
| `lint`                  | clean                                                    |
| `test` (unit)           | **238 passed** — config 25, domain 102, api 111          |
| `test:db`               | **324 passed, 21 skipped**, 11 files, 327.75 s           |
| `audit:design`          | **172/172** screen IDs across 29 artifacts, 0 missing    |
| `format:check` (after)  | clean                                                    |
| Exit code               | **0**                                                    |

Deltas against the 2026-08-25 run: unit 211 → 238 (+27), database 300 → 324 (+24). The 24
new database cases are AUD-001's 23 plus one end-to-end assertion added to
`http-pipeline.db.test.ts`. The 21 skips are the least-privilege cases, which skip on the
default per-file path because it has no `tmanage_app` credential — they are **not** new, and
they were run to 0 skips on 2026-08-25 against both engines.

`Get-Process mysqld` after the run: **none**. The leak recorded in the toolchain table did not
reproduce on this run; it is intermittent, so the check stays in the table.

### The one failure this chain found, and what it was

`http-pipeline.db.test.ts` failed first time on an assertion this session added, and the
failure was in the **expectation**, not the code:

```
expected 'capability_not_in_role_ceiling' to be 'capability_is_internal_only'
```

`CapabilityGuard` makes two independent ceiling checks. The test used a `client_reviewer`
attempting `project.create`, and that role does not hold the capability _at all_, so the first
check refuses and the second is never reached. The expectation was corrected to the code that
actually fires, with a comment saying why — asserting _which_ refusal happened is the point of
the case, so relaxing it to "some audit code" would have removed the only thing it tests.

### An earlier chain run was discarded rather than reported

A first background run was started and then **stopped**, because source files were edited
while it was in flight. Its result would have described a tree that never existed. It is
recorded here rather than omitted: the numbers above come from a single clean run over the
final tree.

---

## MariaDB 11.4.5, run for the first time — 2026-08-25

ADR-0002 recorded that local development is MySQL, deployment is MariaDB, and **CI is the
only place the skew between them is caught**. CI has still never run (see the GitHub
section below), so that gap would have stayed open indefinitely. It is now closed on this
machine instead, without a container.

MariaDB publishes a plain Windows `.zip` build. `mariadb-11.4.5-winx64` is the same version
`compose.yaml` pins (`mariadb:11.4.5-noble`), it needs no installer and no administrator
rights, and it was started with **compose.yaml's own server flags**, copied rather than
approximated:

```
--character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci
--sql-mode=STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION,ERROR_FOR_DIVISION_BY_ZERO
--default-storage-engine=InnoDB --default-time-zone=+00:00
--innodb-flush-log-at-trx-commit=1 --max-connections=100
```

The server confirmed them: `11.4.5-MariaDB`, `sql_mode` exactly as above, `time_zone
+00:00`, `character_set_server utf8mb4`.

### Result

| Step                                 | Result                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| `pnpm db:migrate`                    | **3 migrations, 31 statements, applied clean.** The schema had never run on MariaDB |
| `pnpm db:grants`                     | **26 statements applied.** `scripts/db/users.sql` works on both engines             |
| `pnpm --filter @tmanage/api test:db` | **10 files, 321 passed, 0 skipped**                                                 |

Provenance, as the corpus printed it:
`engine=mariadb 11.4.5-MariaDB · server=external (TMANAGE_TEST_DATABASE_URL) · runtime credential=tmanage_app (least privilege)`.

**ADR-0001 layer 2 is now proven on both engines**, not merely on the one this machine
happens to run.

### What the first MariaDB run found

**One real defect, in the schema-agreement suite's type normalisation.** The comment in
`schema.db.test.ts` claimed to handle MariaDB's display widths. It did not, and could not
have been noticed on MySQL, which stopped reporting display widths in 8.0.19:

- The width branch dropped the **space** along with the width, turning
  `bigint(20) unsigned` into `bigintunsigned` rather than `bigint unsigned`.
- It tested `startsWith('int')`, so `smallint(5)` and `mediumint(8)` were never matched at
  all.

Three columns failed outright — `memberships.version`, `work_items.version`,
`outbox_events.schema_version`. A fourth type, `smallint(5) unsigned`, passed only because
of a fallback that compared both forms again with **every** `(N)` removed.

That fallback was the more serious finding. By the rule that made `smallint(5) unsigned`
agree with `smallint unsigned`, it also made **`varchar(255)` agree with `varchar(64)`** —
so a column silently widened or narrowed by a migration would have passed the drift check.
`normaliseType` now handles the widths that are genuinely noise, and the fallback is gone,
so the comparison is exact. **The suite is stricter after this change than before it.**

Re-run on both engines afterwards, because a normalisation that fixes one engine by
breaking the other is not a fix:

| Engine                  | Result                                             |
| ----------------------- | -------------------------------------------------- |
| MariaDB 11.4.5          | **321 passed, 0 skipped**                          |
| MySQL 8.0.45 (embedded) | **300 passed, 21 skipped** — 47 schema cases green |

### What the run confirmed rather than changed

- **MariaDB really does report `json` as `longtext`.** That rule had been written from
  documentation and never executed. It is now observed. It is also safe for this schema
  specifically: the only `longtext` columns are `audit_events.metadata_json`,
  `idempotency_records.response_json` and `outbox_events.payload_json`, all genuine JSON
  columns, so nothing non-JSON is being normalised into agreement.
- **`SHOW GRANTS` differs in shape, as expected, and nothing depends on it.** MariaDB
  appends `IDENTIFIED BY PASSWORD '<hash>'` to the `USAGE` line and returns the grants in a
  different order; MySQL 8 does neither. No assertion reads the grant text — the suite
  tests what the credential can and cannot _do_ — so the divergence is cosmetic here.
- **Every error code the least-privilege suite asserts is the same on both engines.** All
  22 cases passed on MariaDB unchanged.

### Two environment notes, both Windows rather than MariaDB

Recorded because both cost time and neither is a defect in this project.

1. **`MAX_PATH`.** The first attempt put the data directory under the session scratchpad, a
   path about 210 characters long. Creating
   `...\tmanage\trg_project_memberships_org_immutable.TRN~` exceeded the 260-character
   limit and the migration failed at statement 16 of 20 with
   `Errcode: 2 "No such file or directory"` — which reads like a missing directory and is
   not. Moving the data directory to a 39-character path fixed it completely.
2. **`mariadb-install-db.exe` cannot run without an interactive stdin** — it fails with
   `ERROR: Can't write to mysqld's stdin`. The data directory was bootstrapped directly
   instead, by feeding `mariadb_system_tables.sql`, `mariadb_system_tables_data.sql` and
   `mariadb_performance_tables.sql` to `mariadbd --bootstrap`. The optional `sys` schema was
   omitted: nothing in this project uses it.

The server was stopped afterwards and no stray `mariadbd` or `mysqld` process remains.

---

## GitHub and CI — 2026-08-25

The repository now has a remote. It is **private**, under Peter's own account, created only
after he authenticated the CLI himself.

| Fact         | Detail                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| Remote       | `https://github.com/Peetso/tmanage` — **private**, confirmed by API (`isPrivate=true`) before the first push |
| Account      | `Peetso`. Authenticated by Peter with `gh auth login`; no token was ever shown in chat or written to a file  |
| Token scopes | `gist`, `read:org`, `repo`, `workflow` — `workflow` is required to push `.github/workflows/`                 |
| Pushed       | 3 commits on `master`, tracking `origin/master`                                                              |
| CI           | **Has still never executed a single job.** See below                                                         |

### The first run failed before it started, and not because of the workflow

The push triggered run `#1`, which ended as `startup_failure` in 0 seconds with no jobs
created. GitHub's own annotation gives the reason:

> The job was not started because recent account payments have failed or your spending
> limit needs to be increased. Please check the 'Billing & plans' section in your settings.

**This is an account-billing state, not a defect in this repository.** GitHub Actions
minutes are metered for private repositories; a failed payment or a spending limit of zero
stops jobs from being created at all, which is why the run has no logs and no job list.

The workflow file was verified as sound before that conclusion was drawn, so that "billing"
is not standing in for an unexamined YAML error:

| Check                      | Result                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| YAML parse (`js-yaml`)     | parses; top-level keys `name, on, concurrency, permissions, env, jobs`; 3 jobs with 10, 13 and 9 steps |
| `actionlint` 1.7.7         | **0 errors**                                                                                           |
| Encoding                   | valid UTF-8, no BOM, LF endings; pushed blob is byte-identical (11,487 bytes)                          |
| Repository Actions setting | `enabled: true`, `allowed_actions: all` — not disabled                                                 |

### What this blocks, and the two ways out

Until Actions can run, these stay unproven **by CI** — though the first two are no longer
unproven at all, having been closed locally in this session:

- ~~MariaDB engine skew~~ — closed locally against MariaDB 11.4.5, above.
- ~~`scripts/db/users.sql` against a real server~~ — closed locally, above.
- **gitleaks over the full history in a clean checkout.** Run locally on 2026-08-25 over
  both history and the working tree with no findings, but not from a clean clone.
- **`pnpm install --frozen-lockfile` from a clean checkout**, and the whole chain on Linux
  rather than Windows. Never observed.
- **`compose.yaml` actually starting.** Still never started anywhere; there is no container
  runtime on this machine and CI has not run it.

Two ways forward, and the choice is Peter's:

1. **Resolve the billing state** in GitHub's _Billing & plans_ settings, then re-run. This
   keeps the repository private.
2. **Make the repository public**, for which Actions minutes are free and unlimited. This is
   not reversible in any meaningful sense — forks and caches survive a later switch back —
   and the repository contains the full planning pack and design-system handoff, so it is
   not a decision to take for the sake of a green tick.

Nothing was changed in either direction. The repository remains private and the billing
state remains untouched.

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

| Check          | Command             | Result                                               | Ran against                                     |
| -------------- | ------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| Format         | `pnpm format:check` | **exit 0**                                           | prettier 3.6                                    |
| Typecheck      | `pnpm typecheck`    | **exit 0**                                           | tsc 5.9                                         |
| Lint           | `pnpm lint`         | **exit 0** — 0 errors, 0 warnings                    | eslint 9                                        |
| Unit tests     | `pnpm test`         | **211 passed, 10 files, exit 0**                     | node 22.22                                      |
| Database tests | `pnpm test:db`      | **300 passed, 21 skipped, 10 files, exit 0** (553 s) | **real MySQL 8.0.45** via `mysql-memory-server` |
| Design audit   | `pnpm audit:design` | **exit 0** — 172/172 screen IDs across 29 artifacts  | `docs/design/source/`                           |
| Format (again) | `pnpm format:check` | **exit 0**                                           | after `audit:design` rewrote its output         |

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

| Check                             | Status                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The CI workflow itself**        | **Still never executed a job**, though it now has a runner available. The repository was pushed to GitHub on 2026-08-25 and the first run ended in `startup_failure` in 0s with no jobs created — a **GitHub account billing state**, not a workflow defect (`actionlint` clean, YAML valid, Actions enabled). See "GitHub and CI" above. Everything marked _pending CI_ still rests on it |
| `scripts/db/users.sql`            | **Executed 2026-08-25 against a real MySQL 8.0.45.** All 26 statements applied, `SHOW GRANTS` matches the file, and the 20 least-privilege cases ran rather than skipping. ADR-0001 layer 2 is now proven dynamically on MySQL — **not** on MariaDB.                                                                                                                                       |
| MariaDB engine                    | **Closed 2026-08-25.** The full database suite ran on **MariaDB 11.4.5** — the version `compose.yaml` pins — with the least-privilege credential: 321 passed, 0 skipped. It found one real defect in the schema drift check. ADR-0002's statement that CI is the only place the skew is caught is **no longer true**.                                                                      |
| `compose.yaml`                    | **Still unstarted.** No container runtime on this machine. The MariaDB run above used the same version and the same server flags, but not this file, so `compose.yaml` itself remains unexercised. The removed init-mount is a reasoned correction, not an observed failure.                                                                                                               |
| gitleaks / `pnpm audit`           | **Both now executed locally on 2026-08-25 — see below.** Neither needed Docker or a runner.                                                                                                                                                                                                                                                                                                |
| OpenAPI / event-schema validation | `packages/contracts` not yet scaffolded.                                                                                                                                                                                                                                                                                                                                                   |
| E2E, a11y, RTL, visual regression | Depend on `apps/web`, not yet scaffolded.                                                                                                                                                                                                                                                                                                                                                  |
| Backup/restore rehearsal          | Requires a deployed environment.                                                                                                                                                                                                                                                                                                                                                           |

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
2. ~~**Removing a project membership is a real `DELETE`, and nothing records that it happened.**~~
   **Closed by AUD-001 on 2026-08-26** — `ProjectMembershipsService.remove()` reads the row,
   deletes it, and appends `project_membership.revoked` in the same transaction. The original
   text is kept below, because it is the reasoning the fix had to satisfy.

   **Removing a project membership is a real `DELETE`, and nothing records that it happened.**
   Everywhere else removal is a state, because audit events reference the row. A project
   membership is a _grant_, not a record of something that happened: nothing references it,
   and a soft-deleted grant is one forgotten `WHERE deleted_at IS NULL` away from being live
   again. That trade only holds if the revocation is recorded elsewhere — and today it is
   not, because AUD-001 has no service. `remove()` returns a boolean precisely so the command
   that will write that event knows whether anything was revoked. **This is a gap, not a
   design.**

---

## AUD-001 — the audit service, and the first thing that writes to it

`28-SPRINT-TICKETS` §4 scopes AUD-001 as "append-only audit service/view model", 5 points,
depending on PLAT-004. PLAT-004 built the table, its indexes and its immutability triggers in
`0002_platform_primitives.sql` and they have been tested since; what did not exist was
anything that wrote a row. **No migration was written and none was needed.**

| File                                                    | Role                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/domain/src/policies/audit.ts`                 | The closed action vocabulary and the safe-metadata rule. Engine-agnostic, no dependencies |
| `apps/api/src/modules/audit/audit-events.repository.ts` | Append and the view-model reads. No update, no delete — see below                         |
| `apps/api/src/modules/audit/audit.service.ts`           | `record` (joins the caller's transaction), `recordDenial` (its own), `view`               |
| `apps/api/src/modules/audit/audit.module.ts`            | Global, deliberately — the reason is recorded in the file                                 |
| `src/modules/projects/project-memberships.service.ts`   | The first producer: grant, role change, revocation                                        |

### Four decisions that carry the ticket

1. **The action vocabulary is closed.** `audit_events.action` is a `VARCHAR(190)`, so the
   database would accept anything, and a query for "every role change last quarter" is only
   answerable if every writer spelled the action identically. `AUDIT_ACTION_CATALOG` pairs
   each action with its object type and with the §12 clause that requires it, and the object
   type is **derived from the action** rather than passed in — two call sites cannot write
   `project_membership` and `projectMembership` and make `ix_audit_events_org_object` useless.

   The catalogue holds four actions, not §12's thirteen. Approvals, publication, exports and
   webhook credentials have no implementation, so naming them would create members no query
   could ever return and a reader could not distinguish "never happened" from "never built".

2. **"Safe metadata" is a refusal, not a convention.** §12 says safe metadata; `24-EVENT-CATALOG`
   §1 says "Secrets, full message bodies, raw file content, and unnecessary personal data are
   forbidden". `assertSafeAuditMetadata` admits identifiers and classifications — UUIDs, slugs,
   enum members, counts, flags — and refuses everything else: values limited to
   `[A-Za-z0-9._:-]` at 64 characters (so no sentence, no address, no path), no nested objects,
   no non-finite numbers, `snake_case` keys, and a denylist of key segments. It is called at
   the **repository's write boundary**, so every path into the table crosses it, and it never
   quotes the suspect value back in the error — an error message is a place content leaks to
   as readily as a column.

3. **`record` cannot open a transaction.** §3 step 8 requires the audit row and the state
   change to commit together. `AuditService.record` takes the caller's `TenantQueryRunner` and
   has no access to a pool, so a command physically cannot commit a state change and its audit
   row separately. The database suite proves the property that would otherwise be lost: a
   transaction that fails after both writes leaves **no** audit row.

4. **`recordDenial` may lose an event, and says so.** A refusal has no state change to be
   atomic with, and by the time it is being recorded the response is decided. So that path
   opens its own transaction and swallows its own failures — an audit write that turned a 403
   into a 500 would tell the caller _more_ because the server tried to record that it was
   telling them less. It returns `false` rather than throwing, and a test asserts that against
   a context naming a non-existent organization.

### What this closes

**The gap PROJ-001 recorded in code is closed.** `ProjectMembershipsRepository.remove()` is
the only real `DELETE` in this codebase, justified on the grounds that a grant is not history
— but its own comment said the trade "only holds if the revocation is recorded somewhere
else, and today it is not". `ProjectMembershipsService.remove()` is that somewhere else. It
**reads the row before deleting it**, because afterwards the facts are gone: the audit event
carries the project, the person and the role, so it names something rather than only an id.

It writes **nothing** when nothing was removed. That is what the repository's boolean return
was always for, and it is why a caller cannot manufacture evidence of a revocation by
retrying a delete against an already-absent grant.

**Denied sensitive attempts are recorded** — §12's last sentence. The write is in
`CapabilityGuard` rather than in the exception filter, for three reasons stated in that file:
by that point a membership has been proved, so there is an organization to file the event
under; every attempt reaching that guard is authenticated and inside a tenant, which is what
makes it sensitive and what stops the table becoming a function of what an anonymous crawler
sends; and a filter receives an `ArgumentsHost`, not an `ExecutionContext`, so it cannot name
the capability that was refused.

### Three defects and one collision, found by writing it

1. **The metadata gate refused its own first producer.** `subject_user_id` — the person an
   action is taken upon — trips the `subject` segment, which is on the denylist because an
   email subject line is content. The key was renamed to `target_user_id`; the denylist was
   **not** relaxed. A rule relaxed once for a good reason is a rule the next person relaxes
   for a worse one. A unit case now pins both halves so the decision is found rather than
   rediscovered.
2. **Substring matching would have refused `membership_id`.** The first draft matched
   forbidden fragments as substrings of the key. `ip` appears inside `membership`, so the most
   common legitimate key this system will ever write would have been rejected. Fixed to match
   underscore-separated segments, singular and plural, with a unit case for it.
3. **`project_memberships.role` is a `VARCHAR(64)`, not an enum, and accepts any string.**
   Found because the first draft of the database suite used `'designer'` and `'project_lead'`
   as roles — neither of which exists; `INTERNAL_ROLES` is
   `owner · org_admin · workspace_admin · manager · moderator · member · guest`. The **types**
   caught it and the **database did not**: the rows inserted and read back happily. The suite
   was corrected to real roles. Constraining the column is a migration and is recorded below
   as an open item rather than changed quietly.
4. **A flag was deleted before it shipped.** An early `deniedAttemptIsSecurityEvent` per
   action could not be given a coherent polarity for `security.capability_denied` — an action
   whose only legal result is `denied`, for which "was the denial denied" is not a question —
   and nothing consumed it. Removed, with a note in the file saying what a coherent version
   would have to look like.

### Named gaps in AUD-001, carried deliberately

1. **The view model is narrower than `12-PERMISSION-MATRIX` §2 allows.** §2's audit row reads
   Owner **Full**, Admin **Full**, Workspace Admin **Workspace scope**, Project Lead **Project
   sensitive subset**, Manager **Own activity**, Client Admin **Client-side subset**, Client
   Reviewer **Own decisions**. Two of those are expressible and five are not, because
   `audit_events` has no `workspace_id`, no `project_id` and no `client_organization_id`.
   `view()` implements organization-wide for a principal with organization-wide scope and
   own-activity for everyone else holding `audit.read`, which is the **narrower** reading in
   every unexpressible case. Closing it needs columns and a migration.
2. **No HTTP surface.** The audit _viewer_ is ADMIN-002. A route now would expose a scope
   narrowing the table cannot support.
3. **No outbox event.** §3 step 8 pairs audit with outbox; PLAT-004's relay is still not
   written, so the commands here write the audit half only. The transaction boundary they
   establish is where the second half goes.
4. **Denials before tenant resolution are only half recorded**, and this line read "not
   recorded" until ID-002. That ticket took the second of the two options this sentence used
   to offer — a separate security-event table — and `authentication_events` now records every
   sign-in attempt, including ones that name no user at all. What is still unrecorded is the
   other half: a **missing session** and a **bad CSRF token** are refused in the HTTP guards
   rather than in an identity service, and an unresolvable organization slug is refused by
   `MembershipResolver`. None of the three writes anywhere. Extending
   `authentication_events` to cover the guards is the obvious next step and is not ID-002.
5. **`project_memberships.role` is unconstrained at the database.** See defect 3 above.
   `VARCHAR(64) NOT NULL DEFAULT 'member'` accepts any string, so a typo in a future caller
   that bypasses the TypeScript union persists silently. Correcting it is a migration and is
   the same class of decision as `work_items.state DEFAULT 'triage'`.

---

## UI-001 — the design system, and the defects that measuring it found

`packages/ui` was an empty directory. Every `WEB-*` ticket was blocked on it, 172 screens were
already designed and audited, and nothing in this repository had ever been rendered.

### The token package is checked against its source, not trusted

The design export at `docs/design/source/project/design/tokens/` is immutable, and copying
values out of it by hand is how a design system quietly forks from its design. So the copy is
verified rather than trusted: `tests/tokens.drift.test.ts` reads `tokens.json` and `tokens.css`
at test time and compares them against `src/tokens/tokens.ts` and `src/styles/tokens.css` in
both directions — nothing missing, nothing changed, and nothing **added** that the export does
not contain.

The export's own stylesheet is a subset of its own JSON: `tokens.css` omits the orb sizes, the
type scale, the density compositions and two space steps that `tokens.json` declares. The
package declares them so a component can reach them as custom properties, and the drift test
pins those additions to a named list, each one asserted against the JSON value it came from. A
token cannot enter this package by being typed into a stylesheet.

### Three real accessibility defects, found by computing the contrast rather than trusting it

jsdom has no layout and no paint, so axe-core cannot run its `color-contrast` rule there — it
reports the pairing as _incomplete_, not as a pass. Leaving the rule enabled would have
produced a green result that had checked nothing. It is disabled, the reason is written at the
disabling, and the palette is checked arithmetically instead in `tests/contrast.test.ts`.

That check found three things:

1. **`danger.600`, `success.600` and `warning.600` are used as text by the design artifacts,
   and all three fail AA.** A danger capsule in `TManage Foundations.dc.html` draws
   `border:1px #D9474F; color:#D9474F` on paper. Measured against `paper.0` those are
   **4.23:1**, **4.31:1** and **3.64:1** — below the 4.5:1 that `40-DESIGN-SYSTEM` §10 sets as
   the target. The export is immutable and the palette cannot be widened, so the component
   layer keeps the colour where it is legible — the border and the glyph, which are non-text
   and need 3:1, where all three pass — and sets the word itself in ink (15.46:1). Law 3 still
   holds: the state carries a colour, a shape and a word; it is the shape and not the word that
   is tinted. `client.500` is the one semantic colour that does hold as text (5.37:1) and keeps
   its tint.
2. **The destructive button could not use paper text.** White on `danger.600` is 4.23:1 and
   fails; absolute ink is **4.69:1** and passes. The last control in the system that should be
   hard to read is the one that deletes something.
3. **The export's own "Verified pairings" line is wrong in all five entries.**
   `themes-light-dark-high-contrast.md` claims 12.9 · 14.1 · 6.4 · 11.6 · 6.9; WCAG 2.2
   produces **16.48 · 15.63 · 7.32 · 13.25 · 8.27**. Every printed figure understates the real
   ratio, so no accessibility claim fails because of it — but not one of them is the number.
   The test asserts the claims as floors and records the measured values beside them, rather
   than correcting a file this repository may not write to.

### The laws are enforced by the type system where they can be

- `--ink-950` inverts with the theme: in dark it is `#F5F6F0`. A lime surface that used it
  would be unreadable in dark, which is the exact failure law 1 exists to prevent, so lime and
  danger surfaces carry an absolute ink value in the component layer. The test that proves the
  trap is real is the one asserting that themed ink on dark lime fails AA.
- `OrbButton` cannot be rendered without a `label`, `Field` cannot be rendered without a
  `label`, and `StateCapsule` and `StatusDot` cannot be rendered without their word. A missing
  accessible name is a **type error** rather than an audit finding.
- Every rule in `components.css` uses logical properties. Arabic RTL is a first-class
  requirement in `42-INTERACTION-MOTION-RESPONSIVE-AND-RTL`, and a physical `padding-left` is
  how an RTL layout silently develops a limp.

### Two new lint boundaries, both verified to fire

`jsx-a11y` on every React surface, and a rule that stops the design system importing product
code, contracts, domain types or Next.js — `packages/ui` sits beside `domain` in
`18-REPOSITORY-STRUCTURE`, not above it. Both were proven by writing deliberate violations and
watching them fail (`alt-text`, `click-events-have-key-events`,
`no-static-element-interactions`, and a `@tmanage/domain` import), then deleting the probes.

### Storybook, and what it is for

Theme, contrast, density and direction are toolbar globals rather than separate stories: the
state matrix requires light, dark, high contrast, RTL and reduced motion for **every**
component, and five copies of each story would guarantee that four of them drift. The
foundations page renders the palette, the type scale, the geometry and the three densities from
the token module and prints the measured contrast ratio under each colour.

`storybook build` completes, and the dev server was driven through three stories rather than
merely started: the palette page computes `lime.500` at 16.48:1, the button-states story
renders `aria-busy` and `disabled` correctly, and the dark toolbar global reaches the subtree as
`data-theme="dark"`.

### Named gaps in UI-001, carried deliberately

- **No visual-regression harness.** `48-CLAUDE-CODE-IMPLEMENTATION-START-PROMPT` Phase B lists
  one. It needs a real browser or a hosted service; there is no container runtime here and no
  budget for a paid one. Not built, and not faked.
- **No colour-contrast check on rendered output.** The arithmetic proves the palette; it cannot
  prove that a gradient, an overlay or an inherited colour has not ruined a pairing at runtime.
- **The quiet line is 1.71:1 on paper**, below the 3:1 WCAG 1.4.11 asks of a control boundary.
  That is a property of the export's palette rather than of this package, and
  `[data-contrast="high"]` promotes it to `line.700` (13.73:1). Asserted in the tests so it
  cannot be forgotten; closing it in the default theme would mean changing the design.
- **Fonts are not packaged _by this package_, and that is now deliberate rather than
  outstanding.** `apps/web` packages Manrope with its OFL licence beside it (ADR-0005); a
  design-system package that shipped a `@font-face` would force the URL on every consumer.
  `--font-arabic` (Alexandria) and `--font-mono` (Geist Mono) are still unpackaged and fall
  back to `system-ui` and the platform monospace — neither is in the export at all.
- **`Select`, `Combobox`, `Checkbox`, `Radio`, `Switch`, date/time, `Tooltip` and `Toast` are
  not built.** The design inventory marks them **specified** rather than **built**, and the
  shell, planning, collaboration, delivery and administration families are compositions that
  belong to the `WEB-*` tickets.
- **The four human-validation items are untouched and stay open**: real NVDA and VoiceOver
  passes, a native Arabic RTL screen-reader review, and the Client Portal at 200% zoom. No
  automated check in this package substitutes for any of them.

### Divergences between the planning pack and the design export, recorded rather than resolved

`40-DESIGN-SYSTEM-TOKENS-AND-COMPONENTS.md` §1 calls its own values "executable starter tokens"
that the design phase may tune with evidence, so where the two disagree the export
(`1.0.0-design`) wins over the pack (`0.4.0-planning`). The differences found while building:

| Item            | Planning pack                | Design export                                                |
| --------------- | ---------------------------- | ------------------------------------------------------------ |
| Orbital rail    | 72px expanded / 60px compact | 88px, with a 72px compact                                    |
| Heading weights | 550                          | 600                                                          |
| Latin typeface  | Manrope                      | Manrope in the tokens, **Satoshi in the rendered artifacts** |

The typeface row was open until WEB-001 and is now **closed by ADR-0005**: Manrope ships, and
the reason is the Fontshare EULA rather than a design judgement — §02 forbids serving Satoshi
over the Internet without written consent from the Indian Type Foundry, so it could never have
been self-hosted here. This is the one case where the export's rendered artifacts do **not**
win over the tokens, and it is settled on a ground §1 does not speak to.

---

## Sprint 0 (`28-SPRINT-TICKETS` §3)

| Ticket    | Scope                                              | Status        | Evidence                                                                                                                                                                                                                                                                                                                                         |
| --------- | -------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PLAT-001  | pnpm monorepo, shared config, ownership boundaries | `implemented` | Workspace builds; boundary rules encoded as lint errors in `eslint.config.js`, and the `db` boundary is proven to fire                                                                                                                                                                                                                           |
| PLAT-002  | one-command local stack                            | `implemented` | `compose.yaml` (MariaDB 11.4 · Valkey 8.1 · MinIO). One defect fixed this session (the `users.sql` init-mount could never have succeeded). **Still never started** — no container runtime here; the CI `database` job is what will verify it                                                                                                     |
| PLAT-003  | CI gates, secret/dependency scans                  | `implemented` | `.github/workflows/ci.yml` + `.gitleaks.toml` + `db:grants` + the least-privilege suite. **Not `tested`: the workflow has never run.** Artifact signing deferred (nothing to sign yet); branch protection is an owner action                                                                                                                     |
| OBS-001   | OpenTelemetry correlation + log redaction          | `not_started` | —                                                                                                                                                                                                                                                                                                                                                |
| DATA-001  | migration framework, UUIDv7, app/migration users   | `tested`      | Migrator: 15 database tests + 9 splitter tests. **Exception:** `scripts/db/users.sql` is now covered by 12 static assertions and by a CI suite that has not run; it has still never been executed against a server                                                                                                                               |
| AUTHZ-001 | tenant context + isolation foundation              | `tested`      | 44-case isolation corpus against real MySQL + 45 guard-analyser unit tests + 29 evaluator tests. Under the **admin** credential; the least-privilege re-run is pending CI                                                                                                                                                                        |
| PLAT-004  | transactional outbox + idempotency                 | `implemented` | Tables, append-only audit, per-tenant idempotency uniqueness and the relay escape hatch are tested. The relay/dispatcher itself is **not written**                                                                                                                                                                                               |
| UI-001    | tokens, primitives, Storybook, visual harness      | `tested`      | 106 cases in `packages/ui`: 33 contrast, 14 token drift, 59 component/theme including axe over the whole primitive surface in light, dark, high contrast and Arabic RTL. Storybook builds and was driven through three stories. **The visual-regression harness is not built** — it needs a real browser, and there is no container runtime here |

## Sprint 1 (`28-SPRINT-TICKETS` §4)

| Ticket   | Scope                                          | Status        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------- | ---------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ID-001   | session cookie, refresh rotation/reuse         | `tested`      | 43 database cases + 27 unit cases, now driven through real HTTP as well. Session cookie, rotation, reuse detection, global cutoff, device list, and **CSRF (gap 2 closed — ADR-0004)**. Twenty mutations across two sessions confirm the guards fire. **ID-002 has landed**, so sign-in is real: `AuthenticationService` proves the person and `SessionService.start()` takes the id it established. Six named gaps remain                                    |
| ID-002   | MFA/passkey/recovery architecture              | `tested`      | 213 cases: 52 TOTP against every published RFC vector, 35 password, 23 recovery code, 20 challenge token, 37 credential database cases and 20 over real HTTP, plus 26 in the web app. Argon2id, TOTP, single-use recovery codes and the pre-tenant security log. **Passkeys, SSO, breached-password screening and password recovery are not built** — fourteen named gaps below                                                                               |
| TEN-001  | organization/workspace/membership aggregates   | `tested`      | 21 database cases, plus the membership resolver's 24 and **26 more for provisioning and the directory**. Organization creation now exists: organization, first workspace, founding owner membership and the audit row in one transaction, inside a `TenantContext` bound to the organization being created. Slug changes, workspace-scoped admin and a stored `policyVersion` are still open                                                                  |
| TEN-002  | roles/capabilities and policy evaluator        | `tested`      | The evaluator itself was already tested (29 cases, `packages/domain`). This session wired it: `PrincipalRepository` assembles a `Principal` from a resolved membership plus a scoped project-relation read                                                                                                                                                                                                                                                    |
| TEN-003  | invitation issue/accept/revoke/expiry          | `implemented` | The storage half only: `invite()` writes an `invited` row that authorises nothing, and `transitionStatus()` accepts it. Still no invitation token, no email, no expiry job. ID-001 has landed, so the remaining blockers are the notification surface and a single-use hashed token table of its own                                                                                                                                                          |
| AUD-001  | append-only audit service/view model           | `tested`      | 23 database cases + 26 unit cases. Closed action vocabulary, a safe-metadata rule that refuses content at the write boundary, an append that joins the caller's transaction, and the first producer (project-membership grant/role-change/revocation). Five named gaps below, of which the view-model narrowing is the one that matters                                                                                                                       |
| WEB-001  | identity/onboarding screens                    | `tested`      | 227 cases in `apps/web` after ID-002, TEN-001 and PROJ-002 connected five of the screens: 18 API client, 21 slug, 25 invitation checks, 19 shell, 66 screen (axe over all nine, `region` rule enabled), 11 session flow, 12 sign-in flow, 18 organization flow, 13 project flow, 24 contrast. Nine screens, four shells, `next build` green. **Four of the ten screen states still have no server** and each says so on the screen; fourteen named gaps below |
| TEST-001 | tenant/role matrix harness and two-tenant seed | `implemented` | The seed world and the adversarial pair are exercised by every database run. The **role** half of the §11 matrix — every role against every grid column — is not yet a generated harness                                                                                                                                                                                                                                                                      |

### Named gaps in TEN-001/TEN-002, carried deliberately

1. ~~**Organization creation is not implemented.**~~ **Closed**, and the note was wrong about
   why it was hard. It read: "Provisioning happens before any membership exists, so it cannot
   run under a `TenantContext`, and the bootstrap path is read-only by construction." The
   first clause is true; the second does not follow. `ProvisioningService` generates the
   organization's id first and runs inside a context bound to it, so every statement is scoped
   to an organization nothing else references yet — narrower than any other write in the
   system, with the guard enforcing and reporting nothing.
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

| Component                                         | Status        | Notes                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/config`                                 | `tested`      | 25 tests. MySQL schemes, `DEPLOYMENT_PROFILE`, `TENANT_GUARD_MODE`; production refuses dev substitutes and placeholder secrets                                                                                                                                                                                                                                                                              |
| `packages/domain` — state machines                | `tested`      | 35 tests across all 7 lifecycles in `23-ERD` §5–§11                                                                                                                                                                                                                                                                                                                                                         |
| `packages/domain` — authorization                 | `tested`      | 29 tests over the §11 grid — application layer                                                                                                                                                                                                                                                                                                                                                              |
| `packages/domain` — value objects                 | `tested`      | 11 tests. UUIDv7 (incl. >2³² ms), content hash                                                                                                                                                                                                                                                                                                                                                              |
| `apps/api` — migrator                             | `tested`      | 15 database tests, 9 splitter tests                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/api` — schema (0001, 0002)                  | `tested`      | Applied from empty on every database run; invariants read back from `information_schema`                                                                                                                                                                                                                                                                                                                    |
| `apps/api` — tenant context + guard               | `tested`      | 45 analyser tests, 44 corpus tests                                                                                                                                                                                                                                                                                                                                                                          |
| `apps/api` — least-privilege credentials          | `tested`      | 12 static assertions, plus **21 dynamic cases that now actually run** — against a long-lived MySQL 8.0.45 and again against MariaDB 11.4.5, both with the real `tmanage_app` credential. No container was involved. They still skip on the default per-file path, which has no such credential                                                                                                              |
| `apps/api` — Drizzle schema + guarded seam        | `tested`      | 44 drift cases against `information_schema`, mutation-tested; the seam is proven to keep the guard on the query path                                                                                                                                                                                                                                                                                        |
| `apps/api` — repositories                         | `tested`      | Projects (18 cases), organizations/workspaces/memberships (21), and **client organizations, client memberships, project memberships and work items (49)**. All eight follow one shape. **PROJ-002 adds 19 HTTP cases** over project creation and the workspace list                                                                                                                                         |
| `apps/api` — membership resolver + bootstrap read | `tested`      | 24 database cases. The only waiver of ADR-0001 layer 3, bounded by an audited reason, a read-only rule and a table allowlist — all three mutation-tested                                                                                                                                                                                                                                                    |
| `apps/api` — principal assembly (TEN-002)         | `tested`      | Project relation loaded on the scoped path; a test asserts no guard event is emitted while a principal is assembled                                                                                                                                                                                                                                                                                         |
| `apps/api` — sessions (ID-001)                    | `tested`      | 43 database cases + 27 unit cases. Rotation, reuse detection, global cutoff, device list; the append-only ledger is proven immutable under the admin credential                                                                                                                                                                                                                                             |
| `apps/api` — identity database path               | `tested`      | `identityRead` / `identityTransaction`. Zero tenant tables reachable, enforced in `observe` mode as well as `enforce`; no guard event across a whole session lifecycle                                                                                                                                                                                                                                      |
| `apps/api` — HTTP                                 | `tested`      | NestJS 11 + Fastify. The four-guard pipeline, the stable error envelope, correlation ids, session routes and the first tenant-scoped endpoints: 36 database cases in `http-pipeline.db.test.ts` plus 16 CSRF unit cases and 2 DI cases. Eight mutations confirm the guards fire                                                                                                                             |
| `apps/api` — audit (AUD-001)                      | `tested`      | 23 database cases + 26 unit cases. Append-only proved against the **migration** credential, not only the runtime one; the metadata gate refuses content at the write boundary; a rolled-back command leaves no row; a guard denial is recorded end to end through the real application                                                                                                                      |
| `apps/api` — project-membership commands          | `tested`      | Grant, role change and revocation, each one transaction containing the write and its audit row. The revocation records the facts the `DELETE` destroys                                                                                                                                                                                                                                                      |
| `apps/api` — client requests (REQ-001, REQ-002)   | `tested`      | 47 database cases over real HTTP, 1 skipped. One table with no delete and no update path; the facts §6 requires are written only by the transition that required them; the commitment coherence rule is a trigger, so it holds on a direct SQL session too. Two projections built separately, not one filtered. **REQ-002** makes an acceptance and its work one transaction, with one door onto `accepted` |
| `apps/worker`                                     | `not_started` | Directory exists, empty. `outbox_events` still has no producer and no relay                                                                                                                                                                                                                                                                                                                                 |
| `apps/web`                                        | `tested`      | 296 unit cases across 14 files; **twenty routes** at `next build`. `CL-09` and `CL-10` ship with WEB-004's second half, and `CL-02` now renders two of §6's five kinds of card                                                                                                                                                                                                                              |
| `packages/ui` (UI-001)                            | `tested`      | Token package drift-tested against the design export in both directions; 13 primitives; the contrast arithmetic that jsdom cannot do; Storybook with theme, contrast, density and direction as globals. Three AA defects found and fixed in the component layer                                                                                                                                             |
| `packages/contracts`, `observability`, `test-kit` | `not_started` | Directories exist, empty                                                                                                                                                                                                                                                                                                                                                                                    |
| CI pipeline                                       | `implemented` | Three jobs written, YAML parses, guards proven to fire under `CI=1`. **Never executed** — no runner here                                                                                                                                                                                                                                                                                                    |
| Design source audit                               | `tested`      | 172/172, and now Prettier-idempotent so `audit:design` no longer turns `format:check` red                                                                                                                                                                                                                                                                                                                   |
| Seed world                                        | `tested`      | Exercised by every database run                                                                                                                                                                                                                                                                                                                                                                             |

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

**Absent:** Docker, any container runtime, a Linux distribution under WSL 2.

**Present, contrary to earlier revisions of this line:** MySQL Server 8.0 is installed at
`C:\Program Files\MySQL\MySQL Server 8.0` (service `MySQL80`, stopped, manual start), and
as of 2026-08-25 a portable **MariaDB 11.4.5** runs here too. Both are usable without a
container and without administrator rights — see "MariaDB 11.4.5, run for the first time".

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

**Layer 2 (least-privilege database users) is delivered and observed.** This paragraph said
the opposite until 2026-08-25 and the correction is the point: `scripts/db/users.sql` has now
been executed against a real server twice — a long-lived embedded MySQL 8.0.45 and a portable
MariaDB 11.4.5, the version `compose.yaml` pins — with the whole corpus re-run under the real
`tmanage_app` credential and 0 skips. It found four defects, all fixed at the root. It has
still never run in a container, and it has still never run on Linux.

Engine and access layer are **fixed by the pack** (`03-TECHNICAL-ARCHITECTURE` §2), so
neither was an open decision. ADR-0001 decides only what replaces row-level security.

---

## Next task (recommended)

**This section was stale until 2026-08-26 and is replaced rather than amended.** It previously
read "push to a remote and let the workflow run", written when the repository had one commit
and no remote. Both changed on 2026-08-25: the repository is at
`https://github.com/Peetso/tmanage`, private, and the workflow **will never run** — the first
attempt failed with `startup_failure` in 0 seconds for a billing reason, and Peter has decided
not to pay for GitHub and to keep the repository private. `ci.yml` is not defective;
actionlint reports 0 errors and the YAML parses to 3 jobs. Everything CI was to prove is now
proven locally instead, on both engines.

### The deployment target, recorded 2026-08-26

Peter confirmed the target is **Hostinger shared hosting**, in a subfolder of an existing
site: `/home/u152275336/domains/peetrix.com/public_html/tmanage`. `50-BOOTSTRAP` §3 assumes
**Hostinger Cloud** and deploys `apps/web`, `apps/api` and `apps/worker` as three Node.js
applications. That assumption does not hold, and the planning pack is immutable, so the
divergence is recorded here and belongs in an ADR when a deploy is actually attempted:

- hPanel **does** offer Node.js on this plan (confirmed by Peter), so the platform can run the
  application. The shape differs: the panel starts one application and reverse-proxies it; it
  is not served out of `public_html`, and the plan is unlikely to host three separate
  long-running processes. `apps/worker` is the probable casualty, and §3 already anticipates
  that — "otherwise run controlled worker batches and document the limitation".
- `apps/web` now exists and builds (`next build`, twelve routes). `apps/worker` is still
  an empty directory. There is still nothing to deploy that a person could use, because
  nothing authenticates anybody — but the shape of the eventual deploy is now two
  processes rather than three, which is closer to what this plan can host.
- `compose.yaml` is no more usable there than it is here.

### The next coding task

**`REQ-002` shipped on 2026-08-26 and this section is replaced rather than amended.** It named
REQ-002 as next and said the triage screen "belongs with REQ-002", which was **wrong**:
`28-SPRINT-TICKETS` §7 schedules `WEB-005 manager triage screen and schedule impact` as its own
8-point ticket depending on REQ-002. The correction matters because this file's whole discipline
is not inventing tickets, and that sentence quietly merged two.

**The next one is `WEB-005` — the manager triage screen.**

It is the same argument that made `CL-06` next after REQ-001, from the other side of the
relationship. `REQ-001` and `REQ-002` gave the studio everything: a queue, a clarification, a
decline with a client-safe reason, and an acceptance that commits the work in one transaction.
**None of it has a screen.** A client can now ask for something in a browser and nobody at the
agency can answer without an HTTP client, which is a worse position than the client was in this
morning — they at least had a portal to read.

`22-SCREEN-BY-SCREEN` §5 `TM-12` lists what it needs: "Request content, desired date disclaimer,
files, discussion, client history, duplicate suggestion. Actions: ask clarification, accept,
defer, decline. Acceptance requires committed scope/owner/date. Schedule-impact preview before
accept."

Four of those exist and three do not, and the split is already documented: the content, the
disclaimer, the history endpoint and all four actions are built; files are `FILE-001`, discussion
is `CONV-001`, and duplicate suggestion is a similarity judgement nothing computes. The
**schedule-impact preview** is the one that needs a decision rather than a ticket — nothing in
this system models capacity, so a preview would either be invented or honestly absent, and the
screen should say which.

The alternatives, in order after it:

2. **`SEC-001` — client projection and query policies, and the cross-tenant isolation corpus.**
   Eight points, the last of Sprint 4 besides WEB-005, and its dependency (`CLIENT-001`) has
   been met for two sessions. Much of what it asks for exists as tests already; what it would
   add is the corpus grown to cover the client-projection surfaces that did not exist when
   `tenant-isolation.db.test.ts` was written.
3. **`WEB-002`'s second half.** Saved views, sorting, row selection and bulk actions, including
   the bulk audience change the specification singles out for a separate confirmation.
4. **A mailer.** Nothing sends an invitation; `ON-04` prints the link and asks a person to send
   it. `28-SPRINT-TICKETS` does not schedule this, and the name `MAIL-001` used elsewhere in
   this file is this file's, not the plan's.
5. **`PLAT-004`'s relay** — the outbox dispatcher. Eleven tickets have now established the
   transaction boundary it will publish from, `24-EVENT-CATALOG` names two client-request events
   that nothing emits, and `apps/worker` is still an empty directory. It is also where the rule
   connecting two lifecycles belongs: nothing moves a request to `planned` or `delivered` when
   its linked work item moves.
6. **A `DATE` column for dates that have no time.** `projects.forecast_at`,
   `projects.committed_at` and `client_requests.desired_at` are all `DATETIME(3)` holding
   midnight UTC, so a reader west of UTC sees every calendar date a day early. Not scheduled by
   `28-SPRINT-TICKETS`; it is a migration, and it is recorded in the WEB-004 gaps above.

A note on a name this file uses: **PEOPLE-001 is not a ticket.** `28-SPRINT-TICKETS` does not
schedule a people directory, and earlier entries here named one anyway to have something to
point at. The gap is real — nothing returns a person's name, so every owner reads "Assigned" —
but the ticket number is this file's invention and is recorded as such rather than repeated as
though the plan contained it.

### Done, in the order it happened

1. ~~The membership resolver~~ — 24 database cases; the escape hatch is audited, read-only and
   table-limited, all three mutation-tested.
2. ~~The remaining TEN-001 repositories and TEN-002's wiring~~ — four named gaps recorded.
3. ~~ID-001 §3 step 1~~ — 43 database cases, 27 unit cases, twelve mutations.
4. ~~The HTTP surface~~ — the four-guard pipeline runs §3's steps in order for a real request.
   36 database cases, eight mutations, two ADRs (0003, 0004).
5. ~~PROJ-001's remaining repositories~~ — 49 database cases, no migration.
6. ~~ADR-0001 layer 2 against a real server~~ — `users.sql` executed for the first time, on
   MySQL 8.0.45 and then MariaDB 11.4.5. Four defects found and fixed.
7. ~~AUD-001~~ — the audit service, its view model, and the first producer.
8. ~~UI-001~~ — the token package, thirteen primitives, the harness and Storybook. 106 cases.
   Three real AA defects found by computing the contrast the export only claimed.
9. ~~WEB-001~~ — the Next.js application, four shells, nine screens. 187 cases. ADR-0005.
10. ~~ID-002~~ — Argon2id passwords, RFC 6238 TOTP, single-use recovery codes, the pre-tenant
    security log, six routes, and the sign-in screen wired to them. 213 cases.
11. ~~TEN-001's second half~~ — provisioning and the organization directory. 26 database cases
    and 18 web. Corrects a wrong inference this file carried from the day TEN-001 landed.
12. ~~PROJ-002~~ — project creation with a target date that stays a target, the workspace
    list that makes filing possible, and `ON-03` wired to both. 19 database cases and 13 web.
    Six named gaps, the sharpest being that the owner is not validated against the
    organization.
13. ~~WORK-001~~ — the work aggregate and its six endpoints: the lifecycle wired to the
    machine rather than restated, audience as the whole of client isolation, and a stale
    version refused as a 409 rather than escaping as a 500. 32 database cases. Two defects
    found by its own suite and one by the domain vocabulary test.
14. ~~WEB-002's first half~~ — `TM-03`, `TM-10` and `TM-13`: the transition form asks the
    state machine rather than restating it, a 409 is shown and never retried, and widening the
    audience is confirmed while narrowing is not. 25 web cases. One defect caught mid-chain —
    both screens were showing a page of work as though it were all of it.
15. ~~CLIENT-001~~ — client organizations, their people and project access: thirteen routes,
    one new repository, nine audit actions, and the matrix's hardest sentence — a client admin
    manages their own client organization and nobody else's — proved from both sides. 25
    database cases. Three real defects found by its own suite.
16. ~~TEN-003~~ — invitations: one table, six routes, a token that is hashed and never
    recoverable, single-use enforced by a `WHERE` clause, and an acceptance path that runs with
    no tenant context and still emits no unnamed unscoped statement. 25 database cases. Two
    defects found by its own suite and one by the least-privilege gate.
17. ~~`ON-04` and `ID-03`, wired~~ — the unfinished half of WEB-001, plus the preview endpoint
    `ID-03` needed and TEN-003 had not shipped. Two of the three roles `ON-04` offered turned
    out not to exist. 14 web cases, and a green suite standing beside an unhandled error was
    caught and fixed.
18. ~~CLIENT-002~~ — the client portal: a capability `12-PERMISSION-MATRIX` §1 named and the
    code did not have, a read surface on a path of its own, a projection built field by field
    from §4's allowlist, and a client-admin invitation whose body cannot name a client
    organization. 19 database cases, and the assertion parked since the HTTP surface landed is
    un-parked.
19. ~~WEB-004's first half~~ — `CL-01` and `CL-02`: no internal task percentage and the screen
    says why, an empty state that confirms the notification behaviour, and three fields §6 asks
    for that are named as missing rather than invented. 13 web cases. The portal's links now
    carry a tenant, which they had not since WEB-001.
20. ~~REQ-001~~ — The client request: one table with no delete and no
    update path, a commitment that is one choice enforced by a trigger, two dates that mean
    different things, an audience derived from the state so a clarification lands in the
    client's action queue by itself, and reading carried by the two capabilities the matrix
    actually has. 35 database cases. §6 turns out to have no `triage -> withdrawn` arrow, which
    a failing test found and the diagram confirmed.
21. ~~WEB-004's second half~~ — `CL-09` and `CL-10`: the date said as a
    wish three times, the two dates never on one line, a Withdraw button that appears only when
    the machine would allow it, and `CL-02`'s second kind of card. 21 web cases. Two defects
    found by re-reading and fixed before the chain was recorded, and two divergences inside the
    planning pack recorded rather than resolved.
22. ~~REQ-002~~ — **done this session.** An acceptance and its work as one transaction: a refused
    acceptance now leaves no task in the plan describing work nobody agreed to, `accepted` has
    exactly one door, and the request's history is a read of the append-only audit trail rather
    than a second, mutable copy of it. 12 database cases, no migration.

### Progress

**25½ of 74 tickets. 175 of 615 story points, about 28%, across Sprints 0–9.** WEB-002 counts
half of its 13 points, rounded down. **WEB-004 is whole** and counts all 13; REQ-001 and REQ-002
count their full 8 each. Screen tickets: **3½ of 11** — seven of WEB-001's nine screens do what
they say, three of WEB-002's, and all of WEB-004's.

**Sprint 4 is now five of its seven tickets**, and the two outstanding are `SEC-001` and
`WEB-005`.

The portal is the most finished surface in the product: a client can read what was published to
them, see what is waiting on them, ask for something new, and follow what happened to it. The
studio can answer all of it — over HTTP, with no screen of its own yet.

**Both loops are closed in the browser.** A person signs in, creates an organization, creates a
project, puts work in it, moves that work through its lifecycle, sets up a client organization,
shares the project with it, invites a colleague, and the colleague follows the link and lands
inside. Publish an item to the client and a client member can open the portal and read exactly
that item, with none of the internal record around it.

That is an end-to-end product for the first time. Three things stand between it and something a
team could use for a week:

1. **Nothing sends the invitation.** The link is printed on screen and a person has to send it
   by hand. Nothing else in the loop needs a human to carry it.
2. **The client can now answer, and the studio's half of it has no screen.** `REQ-001` built
   the request, `WEB-004`'s second half built the client's side of it, and `REQ-002` made
   accepting one and committing the work a single transaction. A client asks for something in
   the browser, is told plainly that their date is a wish, and reads the answer with a
   client-safe reason attached. **The studio triages over HTTP only** — there is no triage
   screen, which is the mirror image of where the client was this morning. That is `WEB-005`.
3. **Approving, requesting changes and uploading are still in the position requests were in.**
   `approval.decide` and `file.upload` are in client ceilings with nothing behind them.
   `DEL-001`, `APPR-001` and `FILE-001` are those aggregates, and none has started.
