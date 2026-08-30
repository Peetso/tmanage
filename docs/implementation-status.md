# TManage — implementation status

Status vocabulary is fixed by `15-AI-EXECUTION-HANDBOOK.md` §6:
`not_started` · `designed` · `design_validated` · `contract_defined` · `implemented` ·
`tested` · `release_ready` · `released`.

A row is only `tested` if a check was **actually executed** and its result recorded below.

**Last updated:** 2026-08-31 · **Deployment profile:** `bootstrap` (50-BOOTSTRAP)

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

## Planning-pack reconciliation — re-verified 2026-08-31, start of the e2e-growth session

The **nineteenth** consecutive run, and the table below is this run's output rather than a copy
of the previous one. Every pair was compared by SHA-256 and, separately, by modification time —
pair by pair rather than newest-against-newest. The comparison filters the pack's own
`tmanage/`, `graphify-out/` and design-handoff subtrees, without which the planning scope
reports a spurious "10 differing".

| Scope                                     | Result                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/planning/` vs the pack (SHA-256)    | **61 of 61 byte-identical.** 0 differ, 0 missing, 0 repo-only                                                                                                                                                                                                                                             |
| `docs/design/source/` vs the pack handoff | **147 of 147 byte-identical.** 0 differ, 0 missing, 0 repo-only, 0 pack-only                                                                                                                                                                                                                              |
| Modification times                        | **No pack file is newer than its copy** in either scope. Compared pair by pair: 60 of 61 planning pairs and all 147 design pairs have the repo copy stamped later, and one planning pair (`contracts/tmanage-core.dbml`) is stamped in the same second. That is the shape of a copy taken _from_ the pack |
| Uncopied pack content                     | The same six as the eighteenth run: the five deliberate files — the design-handoff `.zip`, `TManage-Product-System-Master-Plan.docx`, `CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json` — plus the harness artifact `.claude/scheduled_tasks.lock`                                      |
| Conclusion                                | Nothing revised since the previous check. Safe to write code                                                                                                                                                                                                                                              |

Nothing under `docs/planning/` or `docs/design/source/` was written to this session. A stale
copy is refreshed _from_ the pack and never authored.

---

## Planning-pack reconciliation — re-verified 2026-08-30, start of the mailer session

The **eighteenth** consecutive run, and the table below is this run's output rather than a copy
of the previous one. Every pair was compared by SHA-256 and, separately, by modification time —
pair by pair rather than newest-against-newest. The comparison filters the pack's own
`tmanage/`, `graphify-out/` and design-handoff subtrees, without which the planning scope
reports a spurious "10 differing".

| Scope                                     | Result                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/planning/` vs the pack (SHA-256)    | **61 of 61 byte-identical.** 0 differ, 0 missing, 0 repo-only                                                                                                                                                                                                                                             |
| `docs/design/source/` vs the pack handoff | **147 of 147 byte-identical.** 0 differ, 0 missing, 0 repo-only, 0 pack-only                                                                                                                                                                                                                              |
| Modification times                        | **No pack file is newer than its copy** in either scope. Compared pair by pair: 60 of 61 planning pairs and all 147 design pairs have the repo copy stamped later, and one planning pair (`contracts/tmanage-core.dbml`) is stamped in the same second. That is the shape of a copy taken _from_ the pack |
| Uncopied pack content                     | The same six as the seventeenth run: the five deliberate files — the design-handoff `.zip`, `TManage-Product-System-Master-Plan.docx`, `CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json` — plus the harness artifact `.claude/scheduled_tasks.lock` first noted last run                |
| Conclusion                                | Nothing revised since the previous check. Safe to write code                                                                                                                                                                                                                                              |

Nothing under `docs/planning/` or `docs/design/source/` was written to this session. A stale
copy is refreshed _from_ the pack and never authored.

---

## Planning-pack reconciliation — re-verified 2026-08-30, start of the primitives session

The **seventeenth** consecutive run, and the table below is this run's output rather than a copy
of the previous one. Every pair was compared by SHA-256 and, separately, by modification time —
pair by pair rather than newest-against-newest. The comparison filters the pack's own
`tmanage/`, `graphify-out/` and design-handoff subtrees, without which the planning scope
reports a spurious "10 differing".

| Scope                                     | Result                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/planning/` vs the pack (SHA-256)    | **61 of 61 byte-identical.** 0 differ, 0 missing, 0 repo-only                                                                                                                                                                                                                                                                                              |
| `docs/design/source/` vs the pack handoff | **147 of 147 byte-identical.** 0 differ, 0 missing, 0 repo-only, 0 pack-only                                                                                                                                                                                                                                                                               |
| Modification times                        | **No pack file is newer than its copy** in either scope. Compared pair by pair: 60 of 61 planning pairs and all 147 design pairs have the repo copy stamped later, and one planning pair (`contracts/tmanage-core.dbml`) is stamped in the same second. That is the shape of a copy taken _from_ the pack                                                  |
| Uncopied pack content                     | The same five deliberate files as every previous run — the design-handoff `.zip`, `TManage-Product-System-Master-Plan.docx`, `CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json` — **plus one new harness artifact**, `.claude/scheduled_tasks.lock`, a Claude Code lock file belonging to the pack folder's tooling, not planning content |
| Conclusion                                | Nothing revised since the previous check. Safe to write code                                                                                                                                                                                                                                                                                               |

Nothing under `docs/planning/` or `docs/design/source/` was written to this session. A stale
copy is refreshed _from_ the pack and never authored.

---

## Planning-pack reconciliation — re-verified 2026-08-30, start of the DATE-migration session

The **sixteenth** consecutive run, and the table below is this run's output rather than a copy
of the previous one. Every pair was compared by SHA-256 and, separately, by modification time —
pair by pair rather than newest-against-newest. The comparison filters the pack's own
`tmanage/`, `graphify-out/` and design-handoff subtrees, without which the planning scope
reports a spurious "10 differing".

| Scope                                     | Result                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/planning/` vs the pack (SHA-256)    | **61 of 61 byte-identical.** 0 differ, 0 missing, 0 repo-only                                                                                                                                                                                                                                             |
| `docs/design/source/` vs the pack handoff | **147 of 147 byte-identical.** 0 differ, 0 missing, 0 repo-only, 0 pack-only                                                                                                                                                                                                                              |
| Modification times                        | **No pack file is newer than its copy** in either scope. Compared pair by pair: 60 of 61 planning pairs and all 147 design pairs have the repo copy stamped later, and one planning pair (`contracts/tmanage-core.dbml`) is stamped in the same second. That is the shape of a copy taken _from_ the pack |
| Uncopied pack content                     | The same five as every previous run, all deliberate: the design-handoff `.zip` (extracted into `docs/design/source/`), `TManage-Product-System-Master-Plan.docx`, and three Claude Code tooling files belonging to the pack folder — `CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json`  |
| Conclusion                                | Nothing revised since the previous check. Safe to write code                                                                                                                                                                                                                                              |

Nothing under `docs/planning/` or `docs/design/source/` was written to this session. A stale
copy is refreshed _from_ the pack and never authored.

---

## Planning-pack reconciliation — re-verified 2026-08-30, start of the PLAT-004 relay session

The **fifteenth** consecutive run, and the table below is this run's output rather than a copy
of the previous one. Every pair was compared by SHA-256 and, separately, by modification time —
pair by pair rather than newest-against-newest. The comparison filters the pack's own
`tmanage/`, `graphify-out/` and design-handoff subtrees, without which the planning scope
reports a spurious "10 differing".

| Scope                                     | Result                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/planning/` vs the pack (SHA-256)    | **61 of 61 byte-identical.** 0 differ, 0 missing, 0 repo-only                                                                                                                                                                                                                                             |
| `docs/design/source/` vs the pack handoff | **147 of 147 byte-identical.** 0 differ, 0 missing, 0 repo-only, 0 pack-only                                                                                                                                                                                                                              |
| Modification times                        | **No pack file is newer than its copy** in either scope. Compared pair by pair: 60 of 61 planning pairs and all 147 design pairs have the repo copy stamped later, and one planning pair (`contracts/tmanage-core.dbml`) is stamped in the same second. That is the shape of a copy taken _from_ the pack |
| Uncopied pack content                     | The same five as every previous run, all deliberate: the design-handoff `.zip` (extracted into `docs/design/source/`), `TManage-Product-System-Master-Plan.docx`, and three Claude Code tooling files belonging to the pack folder — `CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json`  |
| Conclusion                                | Nothing revised since the previous check. Safe to write code                                                                                                                                                                                                                                              |

Nothing under `docs/planning/` or `docs/design/source/` was written to this session. A stale
copy is refreshed _from_ the pack and never authored.

---

## Planning-pack reconciliation — re-verified 2026-08-29, start of the CHAT-003 verification session

The **fourteenth** consecutive run, and the table below is this run's output rather than a copy
of the previous one. Every pair was compared by SHA-256 and, separately, by modification time —
pair by pair rather than newest-against-newest. The comparison filters the pack's own
`tmanage/`, `graphify-out/` and design-handoff subtrees, without which the planning scope
reports a spurious "10 differing".

| Scope                                     | Result                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/planning/` vs the pack (SHA-256)    | **61 of 61 byte-identical.** 0 differ, 0 missing, 0 repo-only                                                                                                                                                                                                                                             |
| `docs/design/source/` vs the pack handoff | **147 of 147 byte-identical.** 0 differ, 0 missing, 0 repo-only, 0 pack-only                                                                                                                                                                                                                              |
| Modification times                        | **No pack file is newer than its copy** in either scope. Compared pair by pair: 60 of 61 planning pairs and all 147 design pairs have the repo copy stamped later, and one planning pair (`contracts/tmanage-core.dbml`) is stamped in the same second. That is the shape of a copy taken _from_ the pack |
| Uncopied pack content                     | The same five as every previous run, all deliberate: the design-handoff `.zip` (extracted into `docs/design/source/`), `TManage-Product-System-Master-Plan.docx`, and three Claude Code tooling files belonging to the pack folder — `CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json`  |
| Conclusion                                | Nothing revised since the previous check. Safe to write code                                                                                                                                                                                                                                              |

Nothing under `docs/planning/` or `docs/design/source/` was written to this session. A stale
copy is refreshed _from_ the pack and never authored.

---

## Planning-pack reconciliation — re-verified 2026-08-29, start of the CHAT-002 session

The **thirteenth** consecutive run, and the table below is this run's output rather than a copy
of the previous one. Every pair was compared by SHA-256 and, separately, by modification time —
pair by pair rather than newest-against-newest. The comparison filters the pack's own
`tmanage/`, `graphify-out/` and design-handoff subtrees, without which the planning scope
reports a spurious "10 differing".

| Scope                                     | Result                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/planning/` vs the pack (SHA-256)    | **61 of 61 byte-identical.** 0 differ, 0 missing, 0 repo-only                                                                                                                                                                                                                                            |
| `docs/design/source/` vs the pack handoff | **147 of 147 byte-identical.** 0 differ, 0 missing, 0 repo-only, 0 pack-only                                                                                                                                                                                                                             |
| Modification times                        | **No pack file is newer than its copy** in either scope. Compared pair by pair: 60 of 61 planning pairs and all 147 design pairs have the repo copy stamped later, and one planning pair (`00-README.md`) is within two seconds. That is the shape of a copy taken _from_ the pack                       |
| Uncopied pack content                     | The same five as every previous run, all deliberate: the design-handoff `.zip` (extracted into `docs/design/source/`), `TManage-Product-System-Master-Plan.docx`, and three Claude Code tooling files belonging to the pack folder — `CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json` |
| Conclusion                                | Nothing revised since the previous check. Safe to write code                                                                                                                                                                                                                                             |

Nothing under `docs/planning/` or `docs/design/source/` was written to this session. A stale
copy is refreshed _from_ the pack and never authored.

---

## Planning-pack reconciliation — re-verified 2026-08-26, start of the CHAT-001 session

The **twelfth** consecutive run, and the table below is this run's output rather than a copy of
the previous one. Every pair was compared by SHA-256 and, separately, by modification time —
pair by pair rather than newest-against-newest. The comparison filters the pack's own
`tmanage/`, `graphify-out/` and design-handoff subtrees, without which the planning scope
reports a spurious "10 differing".

| Scope                                     | Result                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/planning/` vs the pack (SHA-256)    | **61 of 61 byte-identical.** 0 differ, 0 missing, 0 repo-only                                                                                                                                                                                                                                            |
| `docs/design/source/` vs the pack handoff | **147 of 147 byte-identical.** 0 differ, 0 missing, 0 repo-only, 0 pack-only                                                                                                                                                                                                                             |
| Modification times                        | **No pack file is newer than its copy** in either scope. Compared pair by pair: 60 of 61 planning pairs and all 147 design pairs have the repo copy stamped later, and one planning pair (`00-README.md`) is within two seconds. That is the shape of a copy taken _from_ the pack                       |
| Uncopied pack content                     | The same five as every previous run, all deliberate: the design-handoff `.zip` (extracted into `docs/design/source/`), `TManage-Product-System-Master-Plan.docx`, and three Claude Code tooling files belonging to the pack folder — `CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json` |
| Conclusion                                | Nothing revised since the previous check. Safe to write code                                                                                                                                                                                                                                             |

Nothing under `docs/planning/` or `docs/design/source/` was written to this session. A stale
copy is refreshed _from_ the pack and never authored.

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

## Verification actually run — 2026-08-31, the e2e-growth session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`~22 m` wall, **exit 0**, on the first start. The order mattered and is part of the record:
`pnpm test:e2e` ran **three times before** the chain — once to see the two new specs fail, once
after the fixes, once after a reword — and every repository edit was made between those runs
rather than under a running gate. A six-agent read-only fleet audited the specs' selectors
against the real screens while the first e2e run was still going, and it is what found the
deadlock below before the run could reach it.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                                                                                                  |
| `typecheck`              | Clean                                                                                                                                                               |
| `lint`                   | Clean                                                                                                                                                               |
| `test` (unit)            | **973 passed**, 54 files — up 2 from 971: the triage screen's `needs_clarification` panel and the portal's clarifying withdraw sentence, each pinned where it lives |
| `test:db`                | **777 passed, 29 skipped**, 31 files, **1070.95 s** — unchanged from 777/29; this slice adds no database behaviour                                                  |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                                                                                               |
| `format:check` (closing) | Clean                                                                                                                                                               |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after every e2e run and after the chain                                                                                 |

Outside the chain, `pnpm test:e2e`: **7 passed** in ~1.2 m against the full booted stack — up
from 2. `pnpm test:vr` was **not run and is not owed**: `packages/ui` source, styles and stories
are untouched, and neither screen this slice edits has a VR story.

---

## Verification actually run — 2026-08-30, the mailer session

The full chain, in one uninterrupted background run so that nothing was edited underneath
it. `~23 m` wall, **exit 0**, on the first start. The order mattered and is part
of the record: the review workflow ran **before** the chain — its seven confirmed
findings (below) were fixed and re-verified by the affected suites first, so no running
chain had to be killed for them. `Get-Process mysqld` found no stray server after the
development runs or after the chain.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                                                                                                                                             |
| `typecheck`              | Clean                                                                                                                                                                                                          |
| `lint`                   | Clean                                                                                                                                                                                                          |
| `test` (unit)            | **971 passed**, 54 files — up 19 from 952: four new email unit files (composer, console driver, invitation mailer, the scripted-SMTP wire suite), the config SMTP cases, and ON-04's three delivery renderings |
| `test:db`                | **777 passed, 29 skipped**, 31 files, **1128.88 s** — up 7 from 770/30: the six-case invitation-mail suite and the pinned no-mailer contract in the old TEN-003 suite                                          |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                                                                                                                                          |
| `format:check` (closing) | Clean                                                                                                                                                                                                          |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the database suite and after the chain                                                                                                                       |

Outside the chain, `pnpm test:e2e`: **2 passed** (E2E-02, AUTH-04) in ~1.1 m against the full booted stack. `pnpm test:vr` was **not run and
is not owed**: `packages/ui` source, styles and stories are untouched — the one screen
this slice edits (`InviteTeamScreen`, in `apps/web`) has no VR story.

---

## Five more journeys — and the deadlock the first one walked into

`TEST-003` had two journeys. It now has seven, and the three added to the client-request loop
did what an end-to-end test is actually for: they found something no unit suite could have,
because no unit suite drives two screens in sequence.

### E2E-01 — the loop was deadlocked after a clarification

The catalog's sentence is "client request → clarification → accepted work". Walking it found
that the second arrow does not exist in the running product.

`23-ERD` §6 draws `submitted → triage → needs_clarification → triage → accepted`. The domain
machine implements exactly that: from `needs_clarification` there are two edges, back to
`triage` and out to `withdrawn`. `RequestTriageScreen` disagreed — it treated
`needs_clarification` as an open request and rendered all four outcomes, so a manager who asked
a client a question was offered **Commit with a date**, **Defer with a reason** and **Decline
with a reason**, and the API answered `422` to all three. The only control that moved a request
back to `triage` was **Start triaging**, and that renders solely in the `submitted` branch.

So the studio could ask a question and then never answer the request. There was no route
forward from the screen at all. The fix is the state's own panel:

- `needs_clarification` is no longer "open". It gets **Waiting on the client**, whose one
  control is **The client has answered**, which performs `needs_clarification → triage` — §6's
  route, and the only one it draws.
- The three outcomes are hidden rather than offered and refused. A button the machine rejects
  is worse than no button, which is the same reasoning the `submitted` branch was already
  written from.
- Pinned in `apps/web/tests/triage-flow.test.tsx`: the panel renders, the three outcomes do
  not, and the click posts `{ version, to: 'triage' }`.

This is a **UI defect, not a contract change.** Nothing in `packages/domain` moved and no
planning file was touched; the screen was corrected to match §6, which it had been contradicting
since `WEB-005` landed.

### The portal was telling a client the opposite of what the page above said

The second defect the same journey found. `ClientRequestDetailScreen` renders "You can still
take this back — {studio} has not started on it" whenever the API reports `canWithdraw`. From
`submitted` that is true. From `needs_clarification` it is false and visibly so — the studio's
question is in an alert directly above it. §6 draws both arrows into `withdrawn`, so the button
is correct in both states; only the sentence was wrong. It is now state-aware, and the
clarifying one reads "You can still take this back, even with their question open. Withdrawing
it is an answer too."

The first attempt at that sentence repeated the alert's own phrase and produced a Playwright
strict-mode violation on the next run — two elements for one locator. That is a fair
description of the real problem: the same words twice on one page, once as a heading and once
in a paragraph. The reword fixed both.

### What the journeys assert

| Journey   | Catalog line                                 | What it walks                                                                                                                                                                                                                                     |
| --------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `E2E-01a` | client request → clarification               | client sends a request; studio triages and asks; the studio's screen says whose move it is; the client reads the question word for word and can still withdraw                                                                                    |
| `E2E-01b` | → accepted work, no internal notes           | studio records the answer, commits a date, sees the gap stated and the client's sentence previewed; the client's page shows scope, both dates, and **no** `/work/` link, no internal state word                                                   |
| `AUTH-06` | Atlas client queries another client request  | a _sibling client of the same studio_ gets the same not-found a non-existent request would give, carrying no title, scope or date, and their own list stays empty                                                                                 |
| `E2E-09`  | first organization/project/client onboarding | an organization is founded, its slug derived and confirmed in the URL, a project filed, a teammate invited, the link copied off ON-04 the way a person would, accepted in a second browser context, and the org appears as an internal membership |
| `AUTH-01` | org ID swapped in path                       | a stranger org's slug and the adversarial near-twin `northstar-studios` both get the byte-identical refusal                                                                                                                                       |

### Three narrownesses, said plainly

1. **The client cannot answer the clarification in the portal.** `CHAT-001` built no client-side
   conversation, and `CL-10`'s own copy tells the client to reply however they normally reach the
   studio. The journey models the answer arriving out-of-band, which is what the product does.
   "The client has answered" is the studio recording that, not the client doing it.
2. **`ON-02` stores nothing.** Its forward button is disabled, so `E2E-09` navigates past the
   template step rather than choosing one. The client-organization half of onboarding
   (`ON-05`/`ON-06`) has no screen at all, so `E2E-09` covers the internal half only.
3. **`AUTH-01`'s "no name leaked" assertion passes for a weaker reason than it reads.**
   `/[orgSlug]/work` renders `FIXTURE_ORGANIZATION_NAME` in the header badge regardless of the
   slug, so on `/brightops-consulting/work` the badge says "Northstar Studio". The refusal
   genuinely carries no BrightOps data — the API answers 404 and nothing renders — but the
   header is a fixture rather than a suppression, and this assertion will need re-reading the
   day `GET /v1/organizations/:slug` lands. Recorded rather than deleted.

### One harness change

`e2e/playwright.config.ts` now pins `locale: 'en-US'` and `timezoneId: 'UTC'`. `formatDay` passes
`undefined` to `Intl.DateTimeFormat` **on purpose** — a client reads dates in their own locale —
so "Agreed for September 10, 2026" is an assertion about the browser, not about the product.
Under `en-GB` the same correct page reads "10 September 2026" and the failure would look like a
product defect on somebody else's machine. The browser is pinned; the app is not.

### A Playwright fact worth writing down

`getByText(x, { exact: true })` compares the element's **whole** text, and `StateCapsule` puts an
`aria-hidden` glyph in front of its word. The capsule's text is `"✓Created"`, not `"Created"`, so
an exact-text assertion on a capsule matches nothing. Both new specs had one; the first run
caught the invitation one and the audit fleet caught the identical bug waiting in `E2E-01b`.
They now assert through the surrounding region — `getByRole('region', { name: ... })` plus
`toContainText` — which also lets `E2E-09` assert the negative, since a substring match on
"Created" is case-insensitive and would otherwise be satisfied by "Not created".

---

## The mailer — an SMTP transport behind a port, the invitation as its first producer

Unscheduled by `28-SPRINT-TICKETS`, chosen by this file's own standing order. Before this
slice nothing in the system sent email: `EMAIL_DRIVER` existed in `packages/config` with
no consumer, and ON-04 printed each invitation link for the issuer to send by hand. That
printed link is deliberately still the floor — what changed is that a deployment with a
mail host now also delivers.

**The shape.** A one-method `Mailer` port (`apps/api/src/common/email/`), two drivers
behind it — `ConsoleMailer` (prints, answers `'none'`, refused in production by the
existing guardrail) and `SmtpMailer` (nodemailer 9.0.6, the slice's one new dependency:
SMTP is dot-stuffing, CRLF framing, AUTH encodings and STARTTLS negotiation, each a place
a hand-rolled client corrupts or leaks; the `@node-rs/argon2` decision again). Above the
port, `InvitationMailer` owns the two things the port must not: the accept link —
`WEB_PUBLIC_URL` + `/invitations/<token>`, from configuration and never from a
`Host` header — and the rule that a mail failure never fails the invitation: `deliver`
answers `'sent'`, `'none'` or `'failed'` and does not throw. `MailerModule` mirrors
`DatabaseModule`'s dual shape (`forConfig` in `main.ts`, `forMailer` for a suite that
holds the transport, `none()` as `AppModule`'s default), and the issue/reissue responses
gain a `delivery` field the screen now reads out loud. Config grows `SMTP_HOST` /
`SMTP_PORT` / `SMTP_SECURE` / `SMTP_USERNAME` / `SMTP_PASSWORD` on the s3-credentials
pattern — optional until `EMAIL_DRIVER=smtp` names the host, credentials pair-or-absent,
and `SMTP_SECURE` an explicit true/false enum because `z.coerce.boolean()` reads the
string `"false"` as true. The audit catalog gains `invitation.emailed` — the kind and
the result, never the address.

**A ten-agent review workflow ran before the chain** (four finder lenses — security,
correctness, tests, contracts — each finding handed to an adversarial verifier told to
refute; Peter's standing ten-agent cap). Seven findings were **confirmed** and all seven
are fixed and pinned; four contract-lens verifiers died on a usage limit mid-run, three of
whose claims duplicated findings other lenses had already confirmed, and the fourth —
"the copy divergences are claimed recorded and are not" — is satisfied by this entry.

1. **STARTTLS was opportunistic** (high, security). nodemailer on port 587 upgrades only
   when the server offers it and authenticates either way, so an on-path attacker
   stripping `STARTTLS` from the EHLO reply — or a relay that never offers it — got
   the password and the token-bearing link in cleartext, silently, while the audit row
   said `allowed`. `SmtpMailer` now sets `requireTLS` whenever credentials are
   configured: a session that cannot upgrade fails loudly. Pinned on the wire — the
   scripted server that refuses `STARTTLS` gets no `AUTH` line and no message.
2. **Portal invitations were never emailed** (high, correctness). `ClientsModule` builds
   its own `InvitationsService` for the portal's CL-11 route, and that copy was still
   constructed without the mailer — with SMTP fully configured, a client admin's
   invitation silently answered `delivery: 'none'`. The provider now injects
   `INVITATION_MAILER` like `TenancyModule`'s.
3. **A post-commit audit failure 500ed a committed invitation** (high, correctness). The
   `invitation.emailed` row is written after the invitation's transaction commits and the
   mail is handed over; a transient failure there rejected the whole call — losing the
   response's once-only token for a bookkeeping error that was not the issuer's. The
   write is now caught and logged, the `recordDenial` precedent.
4. **The console driver's every invitation audited as `result: 'error'`** (correctness +
   tests, found by two lenses). `'none'` — the dev default's normal answer — fell
   into the `!== 'sent'` arm. The rule is now: `'none'` writes no audit row, because
   nothing was attempted; only `'sent'` and `'failed'` are recorded.
5. **The no-mailer contract was asserted nowhere** (tests). The old TEN-003 suite —
   the app booted with no mail wiring — now pins `delivery: 'none'` and zero
   `invitation.emailed` rows, so a regression cannot tell every bootstrap issuer their
   email broke while the suite stays green.
6. **The console driver — the shipped default — was untested** (tests). It now has
   a unit file (prints the whole message, answers `'none'`), and the database suite
   drives a `'none'`-answering transport through real HTTP.
7. **SMTP AUTH was never exercised** (tests). The scripted server now advertises and
   honours a real `STARTTLS` upgrade with a self-signed fixture certificate, and the
   suite asserts the exact `AUTH PLAIN` base64 — the credential path runs on a real
   socket before it runs in production.

**Two divergences from `35-NOTIFICATION-AND-EMAIL-COPY` §3, recorded rather than
resolved.** The internal template's `{{scope}}` and the client template's
`{{project}}` name things an invitation row does not hold — `0005_invitations.sql`
has no project column and no scope narrower than the organization — so the internal
body says the organization where §3 says scope, and the client subject says "their
client portal" without naming a project. The preview screen recorded the same absence
when ID-03 landed. §1's checklist is otherwise met line by line: organization, action,
expiry with timezone, why-this-recipient, one CTA, and the inviter as the route for the
unexpected case — there is no preference centre to link, and the body does not pretend
one.

**Known limits, named.** TLS on the wire is proven for STARTTLS with verification off
(the fixture certificate is self-signed); certificate verification itself — on by
default in production — rests on Node and nodemailer. Nothing sends besides the
invitation: password reset and every `35-NOTIFICATION` template stay unrendered, and
NOTIF-001's in-app rows have no email fan-out — the outbox consumer that would carry
those is the natural next producer. Delivery is synchronous in the request; on a slow
relay the issue request waits for it.

**Ticket arithmetic.** No scheduled ticket names a mailer, so the count does not move:
**32 of 70 tickets, 260 of 583 points (44.6%).**

---

## Verification actually run — 2026-08-30, Combobox, DateField, TimeField and the review findings, same session

The full chain, in one uninterrupted background run so that nothing was edited underneath
it. `~1700 s (about 28 m)` wall, **exit 0** — on the fifth start, and the four before it are part of
the record: one died in `typecheck` on two strict-indexing errors in the new `Combobox`
(`noUncheckedIndexedAccess` doing its job), two were killed deliberately minutes in —
before their database phase — when a review fleet landed findings that were going to
change the code anyway, and one died in `lint` on a `jsx-a11y` rule that cannot see the
combobox pattern's keyboard path (the disable carries its justification in place). The
fifth ran the final shape end to end. `Get-Process mysqld` was checked after every kill
as well as after the green run.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                                  |
| `typecheck`              | Clean on the final run; the first run's two `Combobox` strict-indexing findings are described above |
| `lint`                   | Clean                                                                                               |
| `test` (unit)            | **952 passed**, 50 files — up 25 from 927: `pickers.test.tsx` plus the review pins                  |
| `test:db`                | **770 passed, 29 skipped**, 30 files, **1420.68 s** — unchanged; the primitives touch no database   |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                               |
| `format:check` (closing) | Clean                                                                                               |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run, and after the killed second attempt      |

Outside the chain, `pnpm test:vr`: **109 passed** (108 screenshots — 36 stories × 3
variants — plus the empty-index guard), verified green **three times** across the slice:
after the new baselines, after the dark-theme fix below, and after the review fixes.

---

## Combobox, DateField, TimeField — UI-001 closes, and what the harness and a review fleet found on the way

The last slice of the eight. `Combobox` is the WAI-ARIA editable combobox pattern — DOM
focus never leaves the input, the highlighted option is a virtual focus on
`aria-activedescendant`, options are real `role="option"` children of a real listbox.
`DateField` is the DATE-migration convention surfacing in the component layer: its value
IS the `'YYYY-MM-DD'` string the native control speaks, `onValueChange` hands that string
on, and no `Date` object appears in the API in either direction. `TimeField` is its
wall-clock twin (`'HH:MM'`, no zone). 30 unit cases across the slice, two stories, six VR
baselines, and every component of the eight is in the whole-surface axe matrix.

**The harness caught a real dark-theme defect the day the new shots landed.** The new
choice-error shot was unreadable in dark, and the cause was not the new code: a CSS custom
property resolves its `var()` references on the element that _declares_ it, so
`--tm-on-tone`, declared on `:root`, bound the light `--ink-800` once — and every "the
word stays ink" pairing (the `Field` error, the done/blocked/waiting capsule words) had
been **invisible in every dark baseline already committed**, recorded as truth by the
previous session. One redeclaration on `[data-theme='dark']` re-binds it; exactly five
existing dark baselines changed, which is itself the proof of the blast radius.

**Then a review fleet was run over the eight components** (Peter asked for
multi-agent orchestration this session; the fleet was read-only and ran while the chain
did): four reviewer lenses — ARIA, RTL, token law, API contract — each finding
adversarially verified by skeptic agents told to refute. Session capped at five agents
hereafter, at Peter's instruction. Four findings were **confirmed** and all four are fixed
and pinned:

1. **`Combobox` ignored `value` prop changes after mount** (high). The visible text was
   seeded once; a parent clearing the field after submit, or options arriving from the
   API after mount, left the form and the eye permanently disagreeing. The committed
   label now re-derives from the props by render-time sync, pinned by rerender tests.
2. **Edit-then-blur desync** (high). Backspacing "Nadia Rahman" to "Nadia Rahma" and
   tabbing away left the old owner in the form under edited text. Blur now reverts
   half-edited text to the committed label — the form is the truth.
3. **`Tooltip` Escape failed for hover-only opening** (medium) — the WCAG 1.4.13
   "dismissable" claim held only when focus sat on the trigger. While open, the Escape
   listener now sits on the document; pinned with focus parked elsewhere.
4. **`Combobox` keyboard gaps** (medium). ArrowUp now enters the list at the bottom, and
   Enter is always swallowed while the popup is open — a person filtering who presses
   Enter is working the popup, not submitting a half-filled form. Pinned inside a real
   `<form>`.

**The lens the usage limit killed was then re-run as its own five-agent workflow** (one
reviewer, one skeptic per finding — the cap Peter set). It confirmed one more high
finding: the combobox's active option — the virtual keyboard focus itself — was carried
by a ~1.2:1 paper shift alone, effectively invisible in dark, a WCAG 1.4.11 failure. The
active option now wears an inset ink ring, and the contrast suite asserts both halves
arithmetically: the paper shift is under 3:1 in both themes (so the ring can never be
dropped as decoration), and ink-on-paper is over it. The same run _refuted_ two of its
own reviewer's claims — the high-contrast alias hazard (unreachable: only `ThemeProvider`
stamps `data-contrast`, always beside `data-theme`) and a missing Law 3 tone word on
`Toast` (the mandatory sentence is the word, by the system's own documented reading) —
which is the point of paying for skeptics.

Five more reported findings were credible on inspection and fixed in the same slice:
option ids are built from the option's index rather than raw form data (a value with a
space silently broke `aria-activedescendant`); the listbox swallows `mousedown` instead of
cancelling `pointerdown`, so clicking its scrollbar no longer closes the popup and a touch
drag can still scroll it; "No matches" is announced through a status region that exists
from mount rather than being silently visual; `ToastRegion` sets `aria-atomic="false"`
because `role="status"` is implicitly atomic and toast #4 would have re-announced #1–#3;
and the skeleton shimmer — the stylesheet's one physically-directed animation — reverses
under `[dir='rtl']`. The remaining reports (viewport collision handling for the tooltip
bubble, an `aria-activedescendant` scroll pin the suite cannot express in jsdom) are
carried as known limits rather than silently dropped; the fleet's own `laws` lens and
eleven of its verifiers died on a usage limit mid-run and their absence is recorded here
rather than papered over.

**Ticket arithmetic.** All eight specified primitives now exist, tested, storied and
baselined — **UI-001 is whole**: 21 exported primitives, 33 contrast cases, 14 drift
cases, and the harness. **+4 points: 32 of 70 tickets, 260 of 583 points (44.6 %).**

---

## Verification actually run — 2026-08-30, Select, Tooltip and Toast, same session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`~1360 s` wall (about 22 m 40 s), **exit 0** — on the second attempt: the first chain died in
`lint` on an unused `ReactNode` import in `Tooltip.tsx`, the import was removed, and the chain
was started over from the top rather than resumed.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                                  |
| `typecheck`              | Clean across all workspace projects                                                                 |
| `lint`                   | Clean on the rerun; the first run's one finding is described above                                  |
| `test` (unit)            | **927 passed**, 49 files — up 16 from 911: the new `overlay.test.tsx`                               |
| `test:db`                | **770 passed, 29 skipped**, 30 files, **1053.66 s** — unchanged; three primitives touch no database |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                               |
| `format:check` (closing) | Clean                                                                                               |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run                                           |

Outside the chain, `pnpm test:vr`: **103 passed** (102 screenshots — 34 stories × 3 variants —
plus the empty-index guard) in ~47 s. Nine new baselines from `pnpm test:vr:update`, then a
plain verify run before trusting them; no pre-existing baseline moved.

---

## Select, Tooltip and Toast — three more, and the live-region decision

The second slice. Six of the eight primitives now exist; `Combobox` and the date and time
fields remain. 16 unit cases in `tests/overlay.test.tsx`, all three added to the
whole-surface axe matrix, three stories, nine committed VR baselines.

- **`Select`** is a native `<select>` under `Field`'s exact contract — label required,
  hint and error on `aria-describedby`, `aria-invalid` derived from the error's presence.
  The inventory places it in the work-list header, where a filter must work from a
  keyboard, a touch screen and a screen reader on day one; the native element does all
  three, and the platform's own picker on a phone is a feature, not a styling defect. The
  drawn chevron (`appearance: none` removes the native one) is `aria-hidden`: "this is a
  dropdown" is already what the role says.
- **`Tooltip`** is built to WCAG 1.4.13's three demands rather than to a hover effect:
  **dismissable** (Escape hides it without moving focus — pinned by a test that checks
  focus stays put), **hoverable** (the bubble sits inside the wrapper the pointer
  listeners are on, so crossing onto it does not close it), **persistent** (nothing times
  it out). The bubble stays in the DOM whether drawn or not, and the trigger's
  `aria-describedby` points at it permanently — a screen reader gets the description from
  the description mechanism, not from watching visibility change. Keyboard focus opens it,
  because hover-only affordances exclude keyboards. A described-by the trigger already had
  is kept, not clobbered. `defaultOpen` exists for the visual harness, which cannot hover,
  and for nothing else.
- **`Toast` — the live-region decision the next-task note demanded, made and pinned:**
  announcements live on the **region**, not on each toast. `ToastRegion` is
  `role="status"` (implicitly polite), named "Notifications", and the contract is that the
  shell mounts it **empty, before the first toast exists** — a live region created in the
  same tick as its first content is a coin toss on whether anything is announced, and
  that ordering cannot be enforced from inside a component, so it is stated as the
  contract and pinned by a test that renders the region empty and finds it present and
  named. Polite, not assertive: a toast is by definition peripheral — feedback about a
  thing that already happened elsewhere on the screen; anything that must interrupt
  belongs inline next to what it interrupts, which is `InlineAlert`'s job. The primitive
  owns **no timer** — auto-dismiss is application policy (and WCAG 2.2.1 requires it be
  extendable), so the primitive renders for as long as it is rendered. Dismissal, when
  offered, is a real labelled button; omitting the handler omits the button rather than
  drawing one that does nothing. Tones reuse `InlineAlert`'s vocabulary and glyphs; the
  colour stays on the border and the glyph, the word stays ink, per the AA arithmetic.

UI-001's row stays at **half**; totals hold at **31.5 of 70 tickets, 256 of 583 points
(43.9 %)**.

---

## Verification actually run — 2026-08-30, Checkbox, Radio and Switch, the primitives session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`~1470 s` wall (about 24 m 30 s), **exit 0**.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                                  |
| `typecheck`              | Clean across all workspace projects, `packages/ui/vr/` included                                     |
| `lint`                   | Clean                                                                                               |
| `test` (unit)            | **911 passed**, 48 files — up 21 from 890: the new `selection.test.tsx`                             |
| `test:db`                | **770 passed, 29 skipped**, 30 files, **1158.17 s** — unchanged; three primitives touch no database |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                               |
| `format:check` (closing) | Clean                                                                                               |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run                                           |

Outside the chain, `pnpm test:vr`: **94 passed** (93 screenshots — 31 stories × 3 variants —
plus the empty-index guard) in ~44 s. The nine new baselines were produced by
`pnpm test:vr:update` and then verified by a plain `pnpm test:vr` run before being trusted;
no pre-existing baseline changed by a pixel, which is itself evidence the new CSS leaked
into nothing it does not own.

---

## Checkbox, Radio and Switch — three of the eight, and the selection-is-never-lime decision

The first slice of UI-001's remainder. All three are **native inputs under
`appearance: none`** — never repainted `<div>`s — so the keyboard, the form, autofill,
the disabled cascade and the accessibility tree come from the platform, and the component
layer only paints. 21 unit cases in `tests/selection.test.tsx`, all three added to the
whole-surface axe matrix (light, dark, high contrast, RTL, long labels), three stories,
nine committed VR baselines.

**The one decision worth writing down: nothing here is lime.** Law 2 of the token export
reserves lime for _current / next / live_ and names _selection-of-many_ as a forbidden
meaning — and a checked checkbox is exactly selection-of-many. So the checked box, the
chosen radio dot and the "on" switch track are all **ink**, with paper marks: the
`InkButton` pairing the contrast suite already proves AA in both themes. The switch's "on"
was the debatable one — an enabled setting sits near "live" — but a setting that happens to
be on is a chosen value, the same meaning the checkbox carries, and when the doubt is
between two readings of a law the safe side is the one that cannot be wrong. Written here
so a future session does not "fix" the switch to lime without meeting the argument.

The details that carry the accessibility:

- **`Checkbox`** follows `Field`'s contract exactly: label required and real, hint and
  error joined by `aria-describedby`, `aria-invalid` derived from the error's presence and
  never passed in. The mixed state (`indeterminate` — the work list's bulk-select header
  standing over a partly-selected list) is applied as the DOM **property**, so the browser
  itself reports `aria-checked="mixed"`; the paper bar instead of a check says "some of
  them" with a shape, per law 3. The jsdom pin is honest about jsdom: testing-library
  cannot compute the mixed state from the property without paint, so the test asserts the
  property and that checked stays false, rather than pretending to read the tree.
- **`RadioGroup`** is a `<fieldset>` with an explicit `role="radiogroup"` — the fieldset
  contributes the legend and the disabled cascade, and the role is what makes
  `aria-invalid` legal on the group (ARIA permits it on `radiogroup`, not on `group`),
  which is where a "pick one" error belongs: on the choice, never on an arbitrary option.
  The shared `name` is generated when omitted, so two groups on one screen can never
  silently merge by both leaving it off — pinned by a test that renders two anonymous
  groups and checks one radio in each. `Radio` **throws** outside a `RadioGroup`, because
  a radio alone is not a smaller version of the component; it is meaningless.
- **`Switch`** is `<input type="checkbox" role="switch">` — the platform maps checked to
  `aria-checked` itself. It deliberately has **no `error` prop**: a switch is an instant
  action, not a form answer, so "could not apply" is a failed action and belongs to
  `InlineAlert` on the submit path. The thumb travels entirely in logical coordinates
  (`inset-inline-start` at both ends), so the RTL baseline shows the mirrored control
  without a single `[dir]` override in the stylesheet.

Five of the eight remain: `Select`, `Combobox`, the date and time fields, `Tooltip`,
`Toast`. UI-001's row stays at **half**; totals hold at **31.5 of 70 tickets, 256 of 583
points (43.9 %)**.

---

## Verification actually run — 2026-08-30, the visual-regression harness, same session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`~1115 s` wall (18 m 35 s), **exit 0**.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                                              |
| `typecheck`              | Clean — now **including `packages/ui/vr/`**, which is how the `reducedMotion` misplacement below was caught     |
| `lint`                   | Clean — `vr/serve.mjs` joined the node-script glob rather than having its `no-undef` findings suppressed inline |
| `test` (unit)            | **890 passed**, 47 files — unchanged; the harness adds no jsdom surface                                         |
| `test:db`                | **770 passed, 29 skipped**, 30 files, **1029.75 s** — unchanged; the harness touches no database                |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                                           |
| `format:check` (closing) | Clean                                                                                                           |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run                                                       |

Outside the chain, where every browser suite lives, `pnpm test:vr` itself: **85 passed**
(84 screenshots + the empty-index guard) in ~35 s, three consecutive verify runs with zero
pixel drift, and one deliberately broken run — see the negative proof below — before the
baselines were trusted. `pnpm test:e2e` was also run after the DATE migration earlier this
session: **2/2** (E2E-02, AUTH-04).

---

## UI-001's visual-regression harness — the paint gets a witness

`packages/ui/vr/`: Playwright over the built Storybook. Every story in
`storybook-static/index.json` — 28 today, and a new story enrols itself on its next run —
is screenshotted in three variants (**light**, **dark**, **RTL over light**),
element-scoped to `#storybook-root`, and compared against a committed PNG baseline.

**The baseline-artifact decision, weighed in the open as the next-task note asked:**

- **Committed PNGs, beside the spec.** ~1.6 MB for the current 84. The alternatives lost on
  their own terms: a digest-only baseline cannot show a human what changed, and an
  uncommitted baseline is whatever the last run happened to produce — not a baseline.
  Repository growth is real and bounded by intent: element shots, DPR 1, one platform.
- **The baselines are this machine's.** Font rasterisation and antialiasing differ across
  OS and GPU; a PNG from another machine would diff everywhere while nothing changed. There
  is no CI (Actions is dead and stays dead), so "the machine the suite runs on" is the
  honest scope, and Playwright's platform suffix (`-win32`) stays in the filenames to
  say so.
- **A legitimate visual change is one script** — `pnpm test:vr:update` — and the changed
  PNGs are reviewed in the diff like any other file. An unexpected diff leaves its
  actual/expected/diff triple under `test-results/` (gitignored) for a person to look at.
- **High contrast is deliberately absent.** The 33 arithmetic contrast cases compute what a
  screenshot could only eyeball; adding 28 more PNGs to re-prove it would be weight, not
  evidence. RTL, by contrast, had **never been rendered** on this machine — the jsdom suite
  asserts logical properties, and now 28 stories paint right-to-left on every run.

**Determinism, each lever doing one job:** fixed viewport and DPR, one worker,
`animations: 'disabled'`, `caret: 'hide'`, reduced motion at the context, and a wait on
`document.fonts.ready` so the packaged face has painted — the fallback face has different
metrics and would diff every text node.

**Proven in both directions before the baselines were trusted.** Three consecutive verify
runs, zero drift. Then `--lime-500` was deliberately broken (`#b7ff57 → #ff5757`): the
lime-painted shots went red in **light and rtl**, and **dark stayed green** — correctly,
because dark defines its own `--lime-500`. A harness that cannot go red proves nothing;
this one went red exactly where the paint was.

Two small pieces around it: `vr/serve.mjs`, a zero-dependency static server for
`storybook-static` (`file://` breaks the iframe's relative asset fetches, and a dependency
would do less work than its forty lines), and the harness's inclusion in the ui package's
typecheck — which promptly caught `reducedMotion` placed as a test option when it is a
context option.

**Ticket arithmetic, said carefully.** UI-001's row stays at **half, 4 of 8** — the
remainder was two things, and this was the smaller: the eight specified-but-unbuilt
primitives (`Select`, `Combobox`, `Checkbox`, `Radio`, `Switch`, date and time fields,
`Tooltip`, `Toast`) are still missing, and each lands in this harness the day its story
file exists. Totals hold at **31.5 of 70 tickets, 256 of 583 points (43.9 %)**.

---

## Verification actually run — 2026-08-30, the DATE migration, same session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`~1218 s` wall (20 m 18 s), **exit 0**.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                                                                                    |
| `typecheck`              | Clean across all workspace projects                                                                                                                   |
| `lint`                   | Clean                                                                                                                                                 |
| `test` (unit)            | **890 passed**, 47 files — config 25, domain 134, ui 106, test-kit 2, worker 16, api 250, web 357. Web fixtures moved to bare dates; counts unchanged |
| `test:db`                | **770 passed, 29 skipped**, 30 files, **1090.50 s**. Was 769 + 29: the +1 is the 0012 truncation proof in `migrator.db.test.ts`                       |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                                                                                 |
| `format:check` (closing) | Clean                                                                                                                                                 |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run                                                                                             |

Before the chain, the four web test files the change touches were run alone (69 passed) and
the four database suites nearest the blast radius — migrator, req-001, schema drift,
proj-001 — were run alone; that early run is what caught the driver defect below **before**
the full chain was spent on it.

---

## The DATE migration — the day stops arriving early

Migration `0012_calendar_dates.sql`, closing WEB-004 gap 6 and the PROJ-002 date note by
reference (both notes now carry their closure line). Four `DATETIME(3)` columns held
midnight UTC for values that are calendar dates, so `Intl.DateTimeFormat` in any zone west
of UTC rendered every target, desired and committed date **a day early**.

1. **The columns.** `projects.committed_at`, `projects.forecast_at`,
   `client_requests.desired_at` and `client_requests.committed_at` are now `DATE`. The
   previous session's scoping note named three; `client_requests.committed_at` is the
   fourth, converted with them because the triage screen filled it the same midnight-UTC
   way, and leaving it `DATETIME` would have kept exactly the "two conventions that
   disagree" gap 6 warned against.
2. **The carrier type is a string.** `'YYYY-MM-DD'` end to end: drizzle
   `date(..., { mode: 'string' })` in `schema.ts`, string input types in both repositories,
   `parseTargetDate` returning the validated string, a shared `parseCalendarDay` for the two
   request dates, and `Commitment` carrying `day: string` rather than `at: Date`.
3. **A deliberate contract change, said plainly.** `desiredAt` and `commitment` used to
   _require_ ISO instants and refuse bare dates; they now require bare dates and refuse
   instants. The req-001 pins assert the new shape — the refusal case flipped direction
   rather than disappearing. The old parser's "by Friday close of business" argument was
   honest but idle: the only writer is a date input, so every value ever sent was midnight.
4. **The projections** pass the strings through; the `toISOString()` calls on these four
   fields are gone from both request views, the project view and the portal projection.
5. **The screens** send what the date inputs give them — `NewClientRequestScreen` dropped
   its `startOfDay`, the triage screen dropped its `T00:00:00.000Z` suffix — and all three
   `formatDay` helpers render bare dates through `Intl.DateTimeFormat` pinned to **UTC**.
   `work-item-presentation`'s keeps the reader's own zone for full instants, deliberately:
   an instant genuinely happens on different dates in different places, and pinning those
   would be the same lie in the other direction.
6. **`work_items.due_at` stays an instant.** The acceptance path pins the committed day to
   midnight UTC there — the exact value the pre-0012 path stored. Converting that column is
   a WORK-scope decision this migration does not smuggle in.

**The defect under the defect.** With the columns converted and the suite re-run, req-001
read back `'2026-11-14 00:00:00.000'` — a time nobody stored, from a `DATE` column the
drift suite had just certified. The tenant drizzle proxy stringifies JS `Date`s into
DATETIME text for drizzle's positional decoder, and mysql2 inflates `DATE` columns into JS
`Date`s by default — so the string-mode columns received a datetime string. The pool now
sets `dateStrings: ['DATE']`: a `DATE` stays the string it already is, and
`DATETIME`/`TIMESTAMP` keep the `Date` inflation their `mode: 'date'` columns expect. The
types could not catch this and the drift suite could not either — only a read through the
real driver, which is the standing argument for this suite existing.

**Truncation proven, not assumed.** `migrator.db.test.ts` gained a case that applies every
migration below 0012, inserts rows the way production wrote them — calendar dates at
midnight UTC in `DATETIME(3)` — then applies the remainder and reads the four columns back
via `DATE_FORMAT`, so no driver or session timezone touches the comparison:
`2026-09-30 00:00:00.000` comes back `2026-09-30` on the running MySQL 8 engine, and
`information_schema` reports all four columns as `date`. **MariaDB 11.4 was not run this
session**; the both-engines claim for 0012 rests on the documented local-MariaDB procedure
and stays open until someone runs it — recorded as not-run, not as passed.

Ticket arithmetic: none. This was the unscheduled defect fix the previous session's
next-task note scoped; no `28-SPRINT-TICKETS` row moves, and the totals stay
**31.5 of 70 tickets, 256 of 583 points (43.9 %)**.

---

## Verification actually run — 2026-08-30, TEST-003 first half, same session

The eleventh chain run of this session, one uninterrupted background run on the tree
commit `61f99a8` left. **Green on the first attempt** — as it had to be, since the e2e
harness sits deliberately outside every one of these gates.

| Gate                        | Result                                                              |
| --------------------------- | ------------------------------------------------------------------- |
| `pnpm format:check`         | Clean                                                               |
| `pnpm typecheck`            | **Done** — eight projects now: `@tmanage/e2e` joins the walk        |
| `pnpm lint`                 | Clean, no output                                                    |
| `pnpm test`                 | **890 passed across 47 files** — unchanged: e2e runs its own runner |
| `pnpm test:db`              | **30 files, 769 passed, 29 skipped (798)** — unchanged              |
| `pnpm audit:design`         | **172/172 screen IDs across 29 artifacts, 0 missing**               |
| `pnpm format:check` (again) | Clean                                                               |
| Leaked `mysqld`             | **None**, checked after the suite exited                            |

And separately, the thing the chain does not gate: `pnpm test:e2e` — **2 passed in 36
seconds**, through a real Chromium against the real stack.

---

## TEST-003 first half — two journeys through a real browser, outside the chain

Commit before the chain above, and the ticket moves **zero → half (4)**: §6's scope row
reads "E2E-02, AUTH-04, REL-01/02", the first two now run, and REL-01/02 — API instance
loss behind a load balancer — need infrastructure this plan does not have, which caps the
ticket at half on this machine and says so here.

`e2e/` is its own workspace holding a deployment in miniature: an embedded MySQL, the real
migrations through `db:migrate`, the exact two-tenant seed every database suite uses
(reached through a ten-line seed CLI in the API's own test directory rather than importing
TypeScript across a workspace boundary), the API under `tsx`, the web app under `next
dev`, booted once by Playwright's global setup and torn down whole. **Deliberately outside
the verification chain**: the chain's gates are deterministic and ~25 minutes; a
full-stack boot with a browser is a different animal, and welding it in on the day it is
born would put every future ticket behind its worst day. It runs as `pnpm test:e2e` and
earns anything more by track record.

The two journeys, both §-named in `27-TEST-CATALOG`:

- **E2E-02, "Message → task; no duplicate on retry."** Create a channel, say a thing,
  convert it, follow the link — then convert it again and be handed the _same_ item.
  INT-07's guarantee, watched from outside the codebase for the first time.
- **AUTH-04, "deny, no source leak."** A member of the organization who is not in the
  channel opens its URL and learns nothing: the load error, no message text, no composer.

### The harness paid for itself before its first green

Three findings from its own five bring-up runs, each kept:

1. **A stale `.next` cache serves another environment's API.** `NEXT_PUBLIC_*` values are
   inlined at compile time, and a cache warmed under a developer's environment kept
   dialing the developer's port. The harness clears `apps/web/.next` per run, with the
   reason at the call site.
2. **The Next dev server 403s its own chunks under a host it does not expect** —
   `localhost` versus `127.0.0.1`. The constants now say why they are `localhost`.
3. **A real screen defect: the denial page offered a composer.** A member outside the
   room saw "Could not load this channel" — above a "Message the channel" box that could
   never work. The composer now renders only for a loaded channel, and AUTH-04 asserts
   the absence.

`apps/web/AGENTS.md` and `CLAUDE.md` are `next dev`'s own generated agent files,
committed because the generator re-creates them on every run.

---

## The TEST-003 probe — the browser launches, and the zero loses its excuse

Run 2026-08-30, at the end of the relay session, exactly as the previous "next coding
task" prescribed: a probe, not a suite. `playwright-core` 1.55.0 installed into a
scratch directory (nothing entered the repository), `chromium` downloaded through
Playwright's own installer, and a five-line script launched it headless, rendered a page,
and read text back:

    { "launched": true, "text": "probe", "version": "140.0.7339.16" }

**Headless Chromium runs on this host.** Two consequences, recorded rather than acted on:

1. **TEST-003's zero is no longer "no browser here" — it is "not built yet."** E2E-02 and
   AUTH-04 are buildable: Playwright drives a real Chromium against the API and web app
   this repository already runs locally. REL-01/02 remain out of reach honestly — API
   instance loss behind a load balancer is infrastructure this plan does not have — so the
   ticket's ceiling on this machine is a half, and its row's reason should say so when the
   work starts.
2. **UI-001's remainder loses the same excuse.** Its visual-regression harness was
   deferred on "needs a real browser, and there is no container runtime here"; the first
   clause is now satisfied without the second. Still deferred — a screenshot baseline is a
   deliberate artifact decision — but the recorded reason needed this correction.

The heavyweight dependency itself (Playwright plus a browser download) is **not** added by
this probe; that is the first commit of the E2E session's own work, weighed in the open as
the standing rule asks.

---

## Verification actually run — 2026-08-30, RT-001 second half, same session

The tenth chain run of this session (ninth and tenth both belong to RT-001), one
uninterrupted background run on the tree commit `1f617c3` left. **Green on the first
attempt.**

| Gate                        | Result                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm format:check`         | Clean                                                                                             |
| `pnpm typecheck`            | **Done** — seven projects, first pass                                                             |
| `pnpm lint`                 | Clean, no output                                                                                  |
| `pnpm test`                 | **890 passed across 47 files.** Up from 887: the three live-feed screen cases                     |
| `pnpm test:db`              | **30 files, 769 passed, 29 skipped (798)** — unchanged, as it must be: the client is browser work |
| `pnpm audit:design`         | **172/172 screen IDs across 29 artifacts, 0 missing**                                             |
| `pnpm format:check` (again) | Clean                                                                                             |
| Leaked `mysqld`             | **None**, checked after the suite exited                                                          |

---

## RT-001 second half — the channel goes live, and never trusts a frame

Commit before the chain above, and the ticket is **whole (13)**: §6's scope row reads
"socket tickets, authorized subscriptions, cursor/gap", and all three now exist on both
ends of the wire. Presence and typing are not in the row and stay unbuilt, named on the
screen as before.

The mint serves `socketUrl` beside the ticket — a deployment fact the API knows and the
browser must not guess. `null` means this deployment runs no socket (the controlled-batch
truth), and the hook settles at `off` without dialing; the reload behaviour stands
underneath, exactly as the screen's notice now words it.

`useChannelLiveFeed` owns the lifecycle so the screen owns none of it: mint, connect,
subscribe to the open channel, and on **every** frame — and once on `subscribed`, covering
the window between page load and subscription — a refetch through the ordinary authorized
read path. Frame content is never rendered; the durable truth is the API's
(`24-EVENT-CATALOG` §2), and under refetch-on-frame a sequence gap needs no special case —
any later frame, and every reconnect's catch-up, heals it. Reconnects back off
exponentially with full jitter (§6's own words), each attempt minting a fresh ticket,
because the old one died of its sixty-second TTL long before most retries fire. The header
says Live or Reconnecting…; jsdom has no WebSocket, so the socket arrives through an
injectable factory — the `ApiClient` seam's shape — and the suite drives a fake through
subscribe, live delivery via the read path, the null-`socketUrl` quiet settling, and a
drop that reconnects on a fresh mint.

### Named gaps — RT-001 closed, with edges stated

1. **Presence and typing** — not in the scope row, not built, still named on the screen.
2. **Conversations are the only subscription family.** Work, requests and notifications
   would each need their own authorized-subscribe rule.
3. **Single-process fan-out** — the first half's scaling boundary stands: one persistent
   worker, in-process hub, no shared bus on the target.
4. **Live updates depend on deployment.** `REALTIME_PORT` on the worker and
   `REALTIME_PUBLIC_URL` on the API must both be set; either absent degrades honestly to
   reload.

---

## Verification actually run — 2026-08-30, RT-001 first half, same session

The eighth full chain of this session, run twice honestly. **Attempt 1 failed one case,
and the case was a pin doing its job**: the relay suite asserts `message.created.v1`'s
exact payload key set, and RT-001 deliberately added `sequenceNo` to it — an additive,
§3-compatible change is still a change, and now it is an asserted one (`eced710`).
**Attempt 2 green end to end** on the tree `a0db699` + that one-assertion adoption.

| Gate                        | Result                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm format:check`         | Clean                                                                                                                          |
| `pnpm typecheck`            | **Done** — seven projects, first pass                                                                                          |
| `pnpm lint`                 | Clean, no output                                                                                                               |
| `pnpm test`                 | **887 passed across 47 files.** Up from 881: three ticket cases in the domain, three hub cases in the worker                   |
| `pnpm test:db`              | **30 files, 769 passed, 29 skipped (798).** Up from 763: the six realtime cases — real HTTP mint, real relay, real `ws` client |
| `pnpm audit:design`         | **172/172 screen IDs across 29 artifacts, 0 missing**                                                                          |
| `pnpm format:check` (again) | Clean                                                                                                                          |
| Leaked `mysqld`             | **None**, checked after the suite exited                                                                                       |

---

## RT-001 first half — a ticket, a socket, and frames that carry no words

Commits `a0db699` and the pin adoption, verified by the chain above. The ticket is the
plan's own "13→split" and counts **half (6.5)**: the server side of `13-ENGINEERING` §6 is
built and proved sentence by sentence; the browser client, presence/typing, reconnect
jitter and every resource family beyond conversations are the named second half.

### The ticket: stateless, short-lived, and only a handshake

`POST …/realtime/tickets` (behind `conversation.read` — a client principal is refused the
mint itself, and the suite asserts it) converts a session the guards proved into an
HMAC-signed claim: organization, user, expiry. Stateless because the target has no Redis
and a sixty-second token deserves no row; the cost — no revocation inside the TTL — is
priced by making the ticket authorize **only the handshake**. The signing key derives from
the session secret under a fixed context string (`@tmanage/domain/realtime-ticket`, a
subpath export deliberately absent from the domain index so no browser bundle ever meets
`node:crypto`). Verification answers `null` for expiry, tampering, wrong secret and
garbage indistinguishably — a handshake error is an oracle.

### The socket: in the worker, against current rows

The server lives in the worker — the process that already consumes what it fans out — and
starts only in loop mode with `REALTIME_PORT` set; `0` is the default because a host that
runs controlled batches has no process to keep a socket open, and a port nothing answers
would be a lie. A bad ticket closes 4401 with nothing else said. Every `subscribe` names
one conversation and is answered from **current** rows (active membership, ceiling holds,
channel membership exists — the notification consumers' discipline), with the channel's
cursor — the allocator's last handed-out sequence — so a client can tell a gap from a
quiet room. An internal non-member and a foreign tenant's conversation id are refused
indistinguishably.

### The frames: safe projections, and provably wordless

`message.created.v1` gained `sequenceNo` (additive) and the relay's fan-out — registered
beside the real consumers only when a hub exists — delivers event type, object id,
sequence, and the parent id as the minimal safe patch. The live-delivery case posts a
message whose body says "Confidential" and asserts the byte string never crosses the
socket. Delivery is best-effort by design: §2 of the event catalog, "realtime messages are
safe projections of durable events, not the durable bus itself" — a missed frame costs a
refetch, never a fact.

### Named gaps — RT-001, carried deliberately

1. **No browser client.** The channel screen still says "new messages appear when the
   channel is reloaded"; wiring the socket into it — with §6's reconnect backoff and
   gap-refetch — is the second half's first item.
2. **Conversations only.** Work items, requests and notifications have no subscription
   family yet.
3. **No presence, no typing** — §6 gives them ephemeral TTL semantics and excludes them
   from audit; nothing of that exists.
4. **Single-process fan-out.** The hub is in-process memory, honest for one persistent
   worker; a second worker instance would need a shared bus the target does not offer.
   Recorded as the scaling boundary, not solved speculatively.

---

## Verification actually run — 2026-08-30, TEST-002 second half, same session

The seventh full chain of this session, one uninterrupted background run on the tree
commit `0d96816` left. **Green on the first attempt** (the test-kit unit suite's own first
solo run caught one fixture defect — the due-date spread put every date in the past below
day 180 — fixed before anything else saw it).

| Gate                        | Result                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`         | Clean                                                                                                    |
| `pnpm typecheck`            | **Done** — seven projects now: `@tmanage/test-kit` joins the walk                                        |
| `pnpm lint`                 | Clean, no output                                                                                         |
| `pnpm test`                 | **881 passed across 45 files.** Up from 879: the two test-kit cases                                      |
| `pnpm test:db`              | **29 files, 763 passed, 29 skipped (792).** Up from 758: the five volume cases, which are the whole diff |
| `pnpm audit:design`         | **172/172 screen IDs across 29 artifacts, 0 missing**                                                    |
| `pnpm format:check` (again) | Clean                                                                                                    |
| Leaked `mysqld`             | **None**, checked after the suite exited                                                                 |

---

## TEST-002 second half — the performance fixture that cannot flake

Commit before the chain above, and the ticket is **whole (8)**: §5's scope row reads "work
unit/integration/auth/performance fixtures". Unit, integration and auth fixtures have run
since WORK-001 and ID-002 landed; the two named absences were the performance fixture and
an empty `packages/test-kit`. Both closed together, with a judgement recorded rather than
implied:

**"Performance" here is asserted deterministically, on purpose.** A wall-clock budget on a
shared laptop is how flaky suites are born, and the standing rule is that timing raises
come from measurement or not at all. So the fixture asserts the two things about
performance that cannot flake: **the plan** — at two thousand rows the hot work-item reads
are index walks, `EXPLAIN`'s `type` never `ALL` and `07-DATA-MODEL` §9's index among the
candidates (which index an engine picks may differ between MySQL and MariaDB; whether it
_scans_ does not, and the scan is the regression this exists to catch) — and **correctness
at volume**: the 200-row cap exact however much is behind it, a cursor walk over the whole
set complete and duplicate-free, and the adversarial twin's five hundred rows exactly as
invisible as its three always were. If a milliseconds budget is ever wanted, it enters
through a recorded measurement, not through this suite growing a stopwatch.

`packages/test-kit` now exists and holds exactly what `18-REPOSITORY-STRUCTURE` permits
it: **synthetic data only** — no driver, no SQL, no network. `syntheticWorkItemRows`
shapes load rather than copying a row: states cycle in fixed proportions so filters have
something to filter, audiences vary, due dates interleave to both sides of an injected
anchor (its own unit case caught the first draft putting every date in the past), a sixth
carry no date at all, and titles name their ordinal so a paging failure is identifiable by
eye. The suite that wants rows inserted inserts them itself, with its own credential.

---

## Verification actually run — 2026-08-30, TEST-001 second half, same session

The sixth full chain of this session, one uninterrupted background run on the tree commit
`0db71bf` left. **Green on the first attempt.** The suite's own first solo run failed two
cells honestly — the finding is in the section below, and it is about layers, not a bug.

| Gate                        | Result                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`         | Clean                                                                                                       |
| `pnpm typecheck`            | **Done** — six projects, first pass                                                                         |
| `pnpm lint`                 | Clean, no output                                                                                            |
| `pnpm test`                 | **879 passed across 44 files** — unchanged                                                                  |
| `pnpm test:db`              | **28 files, 758 passed, 29 skipped (787).** Up from 749: the nine role-grid cases, which are the whole diff |
| `pnpm audit:design`         | **172/172 screen IDs across 29 artifacts, 0 missing**                                                       |
| `pnpm format:check` (again) | Clean                                                                                                       |
| Leaked `mysqld`             | **None**, checked after the suite exited                                                                    |

---

## TEST-001 second half — §11's role grid, generated from the ceiling it checks

Commit before the chain above, and the ticket is **whole (8)**: §4's scope row reads
"tenant/role matrix harness and two-tenant seed". The seed and the tenant harness (the
isolation corpus and its adversarial pair) have run on every database pass since they
landed; what was missing was the **role** half as a _generated_ harness rather than
sampled examples, and it now exists as `test-001-role-matrix.db.test.ts`.

Seven internal roles are seeded as real memberships and driven over real HTTP against four
capability-gated route families. The verdict for every cell is derived from
`hasCapability` — the domain's own ceiling table — so a deliberate matrix change moves the
harness with it and an accidental one fails it, the same stance SEC-001's operations grid
and NOTIF-001's recipient test already take. Two properties beyond the cells themselves:

- **Every refusal is a counted security event.** The suite requires exactly one
  `security.capability_denied` row per refused cell — a missing row is a silent refusal,
  a surplus row a phantom attempt.
- **The client seam is pinned.** One case proves a client principal refused an internal
  route takes the same audited path; the client side's full grid remains SEC-001's.

### The finding the first run made, kept in the suite

The draft grid included `/portal/requests` (`client_request.submit`), meant as a
refused-everywhere row — and the owner and org_admin cells failed, because their ceilings
**do** include the capability and the guard passes them; the portal _service_ then refuses
any internal principal at the object level, since a request with no client organization is
a row the table cannot hold. That is not a defect — it is `25-AUTH` §3's own architecture
("route guards are UX only") observed from the outside — but a guard grid must not carry a
cell whose allowed half is answered by a deeper layer, so the row is out and the reasoning
stands as a comment where the row would be.

---

## Verification actually run — 2026-08-30, the WORK-002 re-derivation, same session

The fifth full chain of this session, one uninterrupted background run on the tree commit
`c6c38d2` left. **Green on the first attempt**, and so was the suite's own solo run.

| Gate                        | Result                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`         | Clean                                                                                                     |
| `pnpm typecheck`            | **Done** — six projects, first pass                                                                       |
| `pnpm lint`                 | Clean, no output                                                                                          |
| `pnpm test`                 | **879 passed across 44 files** — unchanged                                                                |
| `pnpm test:db`              | **27 files, 749 passed, 29 skipped (778).** Up from 746: the three cursor cases, which are the whole diff |
| `pnpm audit:design`         | **172/172 screen IDs across 29 artifacts, 0 missing**                                                     |
| `pnpm format:check` (again) | Clean                                                                                                     |
| Leaked `mysqld`             | **None**, checked after the suite exited                                                                  |

---

## WORK-002 re-derived — the cursor had shipped; the evidence had not

The smallest honest ticket of the session, and the rule working exactly as written. §5's
WORK-002 row scopes "list/read/create/update endpoints + cursor/version"; every part had
been built for weeks — the `after` keyset cursor since WORK-001 landed, driven daily by
WEB-002's paging — but the count's rule is _built and covered by a check that has actually
run_, and no database case had ever exercised the cursor. The re-derivation therefore cost
three cases in `work-001-work-items.db.test.ts`, not a line of production code:

- **The walk**: pages of two over a known set, in id order, no overlap, no omission, a
  short page ending it — the property a keyset cursor exists for, stated as one equality.
- **Composition**: the page after a cursor still honours the state filter, so paging can
  never silently widen a filtered list.
- **The boundary**: another tenant's work-item id used as a cursor value reaches nothing —
  the tenant predicate binds every row before the id comparison means anything, and the
  response carries nothing of the twin's.

With the cursor evidenced and the version token tested since WORK-001, every word of the
scope row is built and checked: **WORK-002 counts whole (+4)**.

---

## Verification actually run — 2026-08-30, WORK-003, same session

The fourth full chain of this session, one uninterrupted background run on the tree commit
`dea7913` left. **Green on the first attempt.** The suite's own first solo run was not —
one design was corrected mid-ticket, and it is worth its paragraph in the WORK-003 section
below because the corrector was ADR-0001 layer 3 itself.

| Gate                        | Result                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`         | Clean                                                                                                                            |
| `pnpm typecheck`            | **Done** — six projects, first pass                                                                                              |
| `pnpm lint`                 | Clean, no output                                                                                                                 |
| `pnpm test`                 | **879 passed across 44 files** — unchanged: WORK-003's proof is database-shaped                                                  |
| `pnpm test:db`              | **27 files, 746 passed, 29 skipped (775).** Up from 728: twelve WORK-003 cases, and six schema cases the two new tables generate |
| `pnpm audit:design`         | **172/172 screen IDs across 29 artifacts, 0 missing**                                                                            |
| `pnpm format:check` (again) | Clean                                                                                                                            |
| Leaked `mysqld`             | **None**, checked after the suite exited                                                                                         |

---

## WORK-003 — the blocker becomes durable, the edges become real, health becomes a read

Commit before the chain above, and the ticket is **whole (8)**: §5's scope row reads
"blockers/dependencies and health signals", and all three words now have storage, rules
and tests.

### The blocker ledger: US-B04's facts stop vanishing

Before this ticket, entering `blocked` checked `blockerReason` and `blockerAsk` and threw
them away — the machine's requirement was real, the record was not. `0011`'s
`work_blockers` makes the blocker a ledger: raised (reason, ask, optional owner, since)
and resolved (outcome, when, by whom), never deleted, never rewritten. The one legal
update is resolving an open entry exactly once; everything else is refused by trigger for
every credential, exercised from both directions. "One active blocker per item" is the
**engine's** promise: `active_item` is a stored generated column — the item id while
unresolved, NULL after — and the unique key over it refuses a second open entry no matter
who asks. The optional owner is validated as an active member before the transaction
opens: an ask on somebody who cannot act here is an ask on nobody.

`work_item.blocked.v1` joins the catalog (ids only — the reason and ask are prose and stay
on the row, asserted at the byte level) and a fourth relay consumer notifies the ask's
owner, once, against current membership — the same catalog-§6 discipline as the request
consumers, proved idempotent under forced redelivery.

### The edges: immutable, acyclic, and their removal is audited

`work_item_dependencies` — successor points at predecessor. Self-edges are refused by
trigger; duplicates by the unique key; a cross-tenant predecessor answers the same 404 as
one that does not exist; longer cycles by a walk in the repository, including the
transitive case (`a → b → c`, then `c → a` refused) a single-row check cannot see.
Removal is a real DELETE and is audited (`work_item.dependency_removed`), for
`project_membership.revoked`'s reason: the delete destroys the only record, and an edge
quietly removed is a health claim quietly changed.

### Health: computed, explainable, fresh

`GET work-items/:id/health` computes at read time — a stored status is a cache of an
opinion, free to go stale the moment a predecessor's due date moves. An active blocker is
the whole answer (`blocked`, naming the ask and its owner); otherwise a late predecessor
or a blocked one each cost the on-track claim **by name** (`at_risk`, UNIT-12's
"explainable signals"); otherwise `on_track`. A landed predecessor costs nothing, proved
by walking one to `done` and asking again. The answer carries `computedAt`.

### The defect the guard found in its own author, kept

The cycle rule's first draft was one `WITH RECURSIVE` statement — tenant-scoped in both
members, and rejected anyway by the tenant guard's analyser, which is deliberately
conservative about statements it cannot fully parse. The fix was not a waiver and not an
allowlist edit: the walk became level-by-level scoped SELECTs, which the guard reads
plainly and a reviewer does too. Five of the suite's twelve cases failed on the first solo
run because of this one statement; this is the recorded precedent for the next recursive
query someone wants to write.

### A divergence inside the pack, recorded rather than resolved

`contracts/tmanage-core.dbml` draws neither table, while `13-ENGINEERING` §5 names
`work_item_dependencies` in the vertical-slice schema and `23-ERD` §2 draws both
relations. The engineering spec and the ERD win — a scheduled ticket cannot be built
against a contract that omits its subject — and the DDL keeps the house shape so the dbml
can adopt it verbatim when it catches up.

### Named gaps — WORK-003, carried deliberately

1. **No manager override for a late predecessor.** `09-MVP-PRD` §63 admits an "override
   rationale" that preserves the on-track claim; it has no storage, so today a late
   predecessor always costs the claim — the stricter reading.
2. **"Critical" predecessors are not distinguished.** §63 says "critical predecessor";
   every edge counts today, stricter again.
3. **Project-level health (UNIT-12's subject) is not built** — this is per-item health; a
   project roll-up is a read over it that no scheduled screen consumes yet.
4. **No web surface.** The board and detail drawing of blockers and health is screen
   work; the four new endpoints are ready for it.
5. **Blocker edit is refusal-only.** A typo in a reason is fixed by resolving with a note
   and raising anew — the ledger stance, stated so nobody adds UPDATE later without
   noticing what it costs.

---

## Verification actually run — 2026-08-30, NOTIF-001 first half, same session

The third full chain of this session, run twice honestly rather than once approximately.
**Attempt 1 failed one case**, and the case was a gate doing its job: `schema.db.test.ts`
compares the Drizzle `TABLES` map against `information_schema`, and `notifications` had been
added to the schema file without being added to the map — the exact drift the map's own
comment warns about. One line (`79e4bdd`), then **attempt 2 green end to end** on that tree.

| Gate                        | Result                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`         | Clean                                                                                                                        |
| `pnpm typecheck`            | **Done** — six projects, first pass                                                                                          |
| `pnpm lint`                 | Clean, no output                                                                                                             |
| `pnpm test`                 | **879 passed across 44 files.** Up from 876: three worker cases — the recipient rule against the domain's own ceiling        |
| `pnpm test:db`              | **26 files, 728 passed, 29 skipped (757).** Up from 719: six NOTIF-001 cases, and three schema cases the new table generates |
| `pnpm audit:design`         | **172/172 screen IDs across 29 artifacts, 0 missing**                                                                        |
| `pnpm format:check` (again) | Clean                                                                                                                        |
| Leaked `mysqld`             | **None**, checked after the suite exited                                                                                     |

---

## NOTIF-001 first half — one person told one thing, current permissions first

Commits `76a1d2e` and `79e4bdd`, verified by the chain above. The ticket counts **half
(4 of 8)** by the rule: §6's scope row reads "notification record, preferences, bundle
foundation". The record and the foundation are built and tested; **preferences are absent
and have no storage to be built on** — `contracts/tmanage-core.dbml` draws no preferences
table, so building one would outrun the contract rather than implement it.

### The record: a reference envelope with one verb

`0010_notifications.sql` lands the contract's table verbatim: type, object type, object id
— never a title, excerpt or body, because a notification outlives the access decision that
allowed it, and any content it carried would be readable after revocation. The reader
resolves the object through the ordinary authorized read path at display time, where a
revoked object answers 404. Only `read_at` may ever change, forward only; the trigger
refuses everything else for every credential, and the suite exercises it from both
directions. `tmanage_app` holds INSERT and UPDATE (marking read is a person's act,
confined by the trigger); `tmanage_worker` holds INSERT alone. `notifications` registers
in `TENANT_TABLES` in the same commit, per the standing rule — and in the schema drift
map one commit later, per the chain above.

### The consumers: recipients resolved at delivery, not inferred from receipt

Two more `WORKER_OUTBOX_HANDLERS` (the registry moves to `consumers/registry.ts` so
consumers never import each other):

- **`client_request.submitted.v1`** → every internal member whose role ceiling includes
  `client_request.triage` and who can reach the project (org-wide scope, or a project
  membership) — §4's "manager inbox". The capability half is asked of the domain's own
  ceiling (`hasCapability`), not restated; the suite computes its expectation from
  `capabilitiesFor`, so it asserts the wiring rather than a copy of the matrix. The
  member on the project _without_ the capability receives nothing, and that absence is
  asserted by name.
- **`client_request.transitioned.v1`** → the person who asked, `submitted_by_user_id` —
  except `withdrawn`, the submitter's own act and the only client-performed transition §6
  of `23-ERD` has. The dedupe key carries the request version, so the legal
  `triage ⇄ needs_clarification` cycle notifies each time while a redelivery of one event
  never doubles.

Both recipient sets are computed from **current** membership rows inside the delivery
transaction — `24-EVENT-CATALOG` §6's rule, proved by its exact case: a client membership
suspended between the event and its delivery is told nothing.

### The dedupe key is the bundle foundation

`uq_notifications_dedupe` is the consumer's idempotency under at-least-once redelivery
(`ON DUPLICATE KEY UPDATE id = id`, the collision reported as the no-op it is) — and it is
where bundling starts: a bundler is a policy about keys. Widen the key and five events
become one row. The column exists now so that policy has somewhere to live.

### Named gaps — NOTIF-001, carried deliberately

1. **Preferences do not exist.** No table in the contract, no quiet hours, no channel
   choice, no digest. The settings screen in `22-SCREEN-BY-SCREEN` names them; storage is
   a contract decision first, and the half stays half until it is made.
2. **No read surface.** Listing one's notifications and marking one read have no route —
   the position AUD-001 took (service before viewer). The permission matrix names no
   notification capability, so the guard declaration is a decision the read surface's
   ticket must make deliberately rather than this one inventing a capability.
3. **No bundling.** The foundation is the key; the policy over it is unwritten.
4. **Two producers feed it.** Every other §4 event with "notification" among its
   consumers — `membership.invited`, `work_item.blocked`, approvals, deliverables — has
   no producer yet.
5. **`work_item.updated.v1` notifies nobody**, deliberately: a client is answered through
   their request's own transitions, which the lifecycle rule already emits, and an
   internal member watching a board does not need a row per state change.

---

## Verification actually run — 2026-08-30, WEB-003 second half, same session

The second full chain of this session, one uninterrupted background run on the tree commit
`107250c` left (the WEB-003 second-half commit). **Green on the first attempt**, and so were
the new suites' own solo runs — 14/14 and 13/13 first try.

| Gate                        | Result                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm format:check`         | Clean                                                                                              |
| `pnpm typecheck`            | **Done** — six projects, first pass                                                                |
| `pnpm lint`                 | Clean, no output                                                                                   |
| `pnpm test`                 | **876 passed across 43 files.** Up from 858: 14 notation-conversion cases and 4 screen cases       |
| `pnpm test:db`              | **25 files, 719 passed, 29 skipped (748)** — unchanged, as it must be: no API and no table changed |
| `pnpm audit:design`         | **172/172 screen IDs across 29 artifacts, 0 missing**                                              |
| `pnpm format:check` (again) | Clean                                                                                              |
| Leaked `mysqld`             | **None**, checked after the suite exited                                                           |

---

## WEB-003 second half — the composer grows a grammar, the transcript grows a cursor

Commit before the chain above, and the ticket is **whole**: `28-SPRINT-TICKETS` §6's scope
row reads "channel/thread/convert dialog", the first half built all three, and the two
pieces its own record named as the remainder — the rich composer and transcript paging —
are now built and tested. Reactions, saves, pins, presence and live updates stay out and
stay named in `BackendPending`: none has an endpoint, and the scope row does not name them.

### The composer: a notation converted, never markup harvested

The API accepts `bodyRich` — CHAT-002's closed grammar — and never HTML, so a
`contenteditable` surface harvesting markup was never an option. Instead the composer keeps
the plain textarea and defines a small notation over it (`lib/rich-composer.ts` documents
it completely: `**bold**`, `_italic_` at word boundaries so snake_case survives,
`~~strike~~`, backtick code, `[label](https://…)` links on the grammar's own three-scheme
allowlist, `- ` and `1. ` lists, `> ` quotes, fenced code blocks, blank-line paragraphs,
single-newline hard breaks). The toolbar writes notation into the textarea; `composeMessage`
converts it to grammar nodes; the preview renders the converted document through the same
`RichTextBody` the transcript uses — what is previewed is what a reader will see, not a
second renderer's opinion. The notation itself never leaves the browser.

Three rules keep it honest:

- **Unmatched notation is literal.** A lone `**`, a `_` inside an identifier, a link whose
  scheme the grammar refuses — all stay exactly as typed. Refusal-over-repair, one step
  before the sanitiser.
- **An unformatted draft stays plain.** `composeMessage` answers `plain` and the send
  carries `body`, exactly as before this half; a rich document wrapping unformatted text
  would say something false about what was written.
- **The domain's own gate runs before the network.** A rich send passes through
  `sanitizeRichText` — the same function the API applies — in the browser first, so an
  inadmissible document is refused with the path to the offending node while the author can
  still see what they typed.

The suite's strongest case is a property, not an example: every document the notation can
emit is admissible to `sanitizeRichText`, asserted over a corpus of drafts, because a
composer able to build a document the API refuses would hand the author an error about a
tree they never saw.

### The paging: WEB-002's shape on the channel's own order

The cursor is `afterSequenceNo` — the sequence number CHAT-001's allocator hands out under
the channel's own row lock, which is the transcript's order by construction. Pages
accumulate under one query key for the channel and for a thread's replies alike; the old
full-page warning ("paging back through history is the second half of this screen") is
replaced by a count that says "loaded — there are more" and a Load more that means it, and
a short page retires both. The retry-dedupe composer behaviour and every first-half case
still pass untouched.

18 new web cases: 14 in `rich-composer.test.ts` enumerating the conversion — inline marks,
lists, quotes, verbatim fences, the year-with-a-period that must not become a list, the
`javascript:` link that stays literal text, the admissibility property — and 4 in
`chat-flow.test.tsx` driving the toolbar, the preview, the plain-draft path and the cursor
through the screen.

### Named gaps — WEB-003, carried deliberately

1. **Marks do not nest and there is no escape character.** Bold-inside-italic cannot be
   written, and a literal `**pair**` cannot be written unbolded. Both are limits of a
   notation this size, stated in the module doc; a full editor is a different piece of work
   and nothing scheduled asks for one.
2. **New messages still arrive by reload.** `RT-001` is the live-updates ticket, now
   unblocked by PLAT-004; until it lands the channel says so in `BackendPending`.
3. **Reactions, saves, pins, presence, quote-to-decision** — unchanged from the first-half
   record: no endpoint, no table, no ticket. Named on the screen, not drawn as dead
   buttons.
4. **`TM-07` direct messages still have no API** — a conversation requires a project, and
   the honest absence recorded at the first half stands.

---

## Verification actually run — 2026-08-30, the PLAT-004 relay session

One uninterrupted background run on the tree commit `44211eb` left (both PLAT-004 commits
plus their prettier pass). **Green on the first attempt.** The relay suite's own earlier solo
run was not: its first pass failed three cases on a fixture defect worth keeping (the
time-zone note in the PLAT-004 section below), fixed before the chain started.

| Gate                        | Result                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`         | Clean                                                                                                                                    |
| `pnpm typecheck`            | **Done** — six projects now: `@tmanage/worker` joins the walk, built before the API's typecheck because the relay suite imports its dist |
| `pnpm lint`                 | Clean, no output                                                                                                                         |
| `pnpm test`                 | **858 passed across 42 files.** Up from 848: ten worker unit cases — backoff arithmetic, the state mapping, the handler registry         |
| `pnpm test:db`              | **25 files, 719 passed, 29 skipped (748)** — up from 705: the 14 relay cases in `plat-004-relay.db.test.ts`                              |
| `pnpm audit:design`         | **172/172 screen IDs across 29 artifacts, 0 missing**                                                                                    |
| `pnpm format:check` (again) | Clean                                                                                                                                    |
| Leaked `mysqld`             | **None**, checked after the suite exited                                                                                                 |

---

## PLAT-004 — the relay runs, and the two lifecycles connect

Two commits, `567d263` (the writer and five producers) and `482f237` (the worker, the
dispatcher and the one consumer), verified together by the chain above. `apps/worker` is no
longer an empty directory, and `outbox_events` — which has had its table, its indexes and its
immutability trigger since `0002` — has producers and a drain for the first time.

### The writer joins the transaction; the vocabulary joins the domain

`OutboxEventsRepository.append` is `AuditEventsRepository.append`'s shape for the same
reason: it takes the caller's `TenantQueryRunner` and cannot open a transaction of its own,
so an event can only commit with the state change it describes — §3 step 8, proved by a
rolled-back transaction that leaves no row. The five event types live in
`packages/domain/src/events/outbox.ts` as a closed catalog the way the audit actions do:
the aggregate type is part of each definition (`outboxAggregateTypeFor`, never a caller's
choice), and each type is bound to its payload shape at the type level, so pairing
`message.created.v1` with the wrong payload is a compile error. Payloads are
`24-EVENT-CATALOG` §5's minimums — ids and states, never bodies — and the suite asserts it
at the byte level against the one event whose source is a sentence a person typed.

Five producers, all inside existing service transactions: submitting a client request
(`client_request.submitted.v1`), every transition including the acceptance's own door
(`client_request.transitioned.v1`, field names matching the registered contract schema),
posting a message (`message.created.v1`, the conversation as aggregate so per-channel
ordering holds), converting one (`message.converted.v1`), and a work item's state transition
(`work_item.updated.v1`).

### The dispatcher: one batch is one transaction

`apps/worker` follows `18-REPOSITORY-STRUCTURE`'s layout — `src/outbox`, `src/consumers`,
and a `src/common/database` that is the one place the lint allowlist lets a worker file hold
a driver handle or spell SQL. The claim is `FOR UPDATE SKIP LOCKED` over
`published_at IS NULL AND available_at <= NOW(3) AND attempts < cap`, ordered
`(available_at, id)`; each handler runs in a savepoint; success stamps `published_at`;
failure rolls the handler's writes back and records `attempts + 1`, the error, and an
exponentially backed-off `available_at`. At the attempt cap an event is parked — never
claimed again, listed in every batch report, replayable only by an operator resetting its
`attempts`. A type with no registered handler is dispatched to zero consumers and published,
so the backlog cannot grow unboundedly while `NOTIF-001` and `RT-001` remain unbuilt.

`50-BOOTSTRAP` §3 deploys a third always-on process **only if the plan supports one
reliably** — so `runOutboxBatch` is the unit (one claim, one transaction, one report) and
`runOutboxLoop` is that unit repeated with a pause, stoppable by `AbortSignal`.
`pnpm --filter @tmanage/worker relay:once` is the controlled-batch deploy story on the
shared plan; the loop is the same code path, not a second implementation.

### The one consumer: the rule REQ-002's link was waiting for

When committed work starts, its linked request moves `accepted → planned`; when the work is
done, `planned → delivered` — the two arrows `23-ERD` §6 has always had and nothing ran.
The consumer reads exactly those two states: a declined request stays declined however its
work item is reused (asserted), and a request already at the target is the at-least-once
replay case — already-there is success, no second transition, audit row or event (asserted
by un-publishing the delivered event and delivering it again). Each applied rule writes, in
the claiming transaction: the state change guarded by the state it was read under, an audit
row with `actor_user_id` NULL — the system-initiated case the column has been nullable for
since `0002` — and the relay's own `client_request.transitioned.v1`, both carrying the
correlation id of the person who moved the work, so the causal chain answers to one id.
The move's legality is still asked of `clientRequestStateMachine` rather than restated.

`scripts/db/users.sql` grants `tmanage_worker` UPDATE on `client_requests` for this — the
one grant the relay's credential was missing, UPDATE only, with the reason in the file.

### Where the proof lives

The db-level proof is `apps/api/test/plat-004-relay.db.test.ts` — 14 cases driving the
dispatcher **imported from `@tmanage/worker`** against the same embedded server as the rest
of the corpus, so the harness exists once (the scoping decision recorded last session). The
worker's own suite holds the pure half: backoff arithmetic and the state mapping, 10 cases.
`packages/config` gained the five `OUTBOX_*` variables (batch size, attempt cap, poll
interval, backoff base and cap); the worker consumes `@tmanage/config` and reads no
`process.env` of its own.

One defect found by the relay suite's own first run, worth keeping: the harness's admin
pool runs in the server's local time zone while every application session runs UTC, so
admin-written `now(3)` fixtures landed three hours in the relay's future and were never
due. The fixtures now write `utc_timestamp(3)`; the application paths were never wrong.

### Named gaps — PLAT-004, carried deliberately

1. **`work_item.updated.v1` is emitted for state transitions only.** §4's trigger reads
   "fields/state changed"; a field edit (title, dates, audience) emits nothing. The
   narrowing is stated at the producer. Widening it is additive when a consumer wants it.
2. **The rest of §4 still has no producers** — `work_item.created.v1`,
   `organization.created.v1`, `membership.invited.v1` and everything below them. Same rule
   as the audit vocabulary: a type joins the catalog when its producer does.
3. **Every event today is dispatched to zero consumers except `work_item.updated.v1`.**
   `NOTIF-001` (notification records) and `RT-001` (realtime) are the consumers §4 names,
   and both were waiting on this ticket.
4. **`client_requests.linked_work_item_id` carries no index**, so the consumer's lookup is
   a scan. Tolerable today (the table is small and the column was never queried before);
   an index is a migration, recorded here rather than slipped into one.
5. **The suite runs the relay under the harness credential, not `tmanage_worker`.** The
   grants are still asserted statically only — the PLAT-003 gap narrows but does not
   close. Exercising them needs a `TMANAGE_TEST_WORKER_DATABASE_URL` path through the
   harness, unscheduled.
6. **Parked events have replay-by-hand only** — an operator resets `attempts`. §2 asks for
   "replay tooling"; a `relay:replay` script belongs with the first real parked event or
   with OBS-001's operational surface, whichever arrives first.
7. **No contract-schema validation at the write.** The payload shapes are compile-time
   types; the JSON Schemas in `contracts/events/` are not executed against them. §7's
   "registers examples in contract tests" remains open.

---

## Verification actually run — 2026-08-30, WEB-002 second half, same session

The third full chain of this session, one uninterrupted background run on the tree commit
`d4beb49` left (the WEB-002 second-half commit). **Green on the first attempt**, and so
were the new tests themselves — 54/54 across the two touched files on their first solo run.

| Gate                        | Result                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`         | Clean                                                                                                               |
| `pnpm typecheck`            | **Done** — five projects, first pass                                                                                |
| `pnpm lint`                 | Clean, no output                                                                                                    |
| `pnpm test`                 | **848 passed across 40 files.** Up from 840: seven new cases in `work-flow.test.tsx`, one in `triage-flow.test.tsx` |
| `pnpm test:db`              | **24 files, 705 passed, 29 skipped (734)** — unchanged, as it must be: no API and no table changed                  |
| `pnpm audit:design`         | **172/172 screen IDs across 29 artifacts, 0 missing**                                                               |
| `pnpm format:check` (again) | Clean                                                                                                               |
| Leaked `mysqld`             | **None**, checked after the suite exited                                                                            |

---

## WEB-002 second half — the list grows honest controls, and the count does not move

Commit after the chain above. Four things, each with its rule stated at the point of use:

- **Cursor paging, both lists.** The work list and the request inbox page on the API's `after`
  id cursor with a "Load more"; the inbox heading now says "200 requests loaded — there are
  more" instead of "in total", which is the sentence that screen owed since WEB-005 shipped
  it showing the oldest 200 silently.
- **Sorting over the loaded rows**, from real header buttons carrying `aria-sort` — title,
  state (in lifecycle order, not alphabetical), due with no-date last. The API offers no sort
  parameter, so while more pages exist the partial-list notice stays up: "sorted" never
  silently means "sorted some of it". A third click returns to loaded order.
- **Selection and the one bulk action: audience.** Widening shows §5's "policy preview" as a
  list of consequences — the titles, verbatim, of exactly the items a client will begin to
  see — before anything is sent. Narrowing applies without ceremony (nothing new escapes).
  Each `PATCH` carries the version its row was read with; a `409` is reported **by title**
  and never retried, because a bulk retry with fresh versions is the lost update multiplied.
  Updates run sequentially on purpose, so "which ones happened" is a fact rather than a race.
- **`ProjectOverviewScreen`'s badge tells the truth or nothing.** The unconditional
  "Internal" — capable of being wrong since CLIENT-001 landed, and recorded as such — is
  replaced by a query to `GET projects/:id/clients`: "Internal" only after an empty answer,
  "Shared with a client" after a non-empty one, and **no badge at all** when the endpoint
  refuses (it sits behind `project.manage`), because a badge the screen cannot verify is the
  guess this change exists to remove.

**The progress count does not move, and that is the honest reading of the rule.** WEB-002's
scope names saved views, and saved views are still absent — now for a stated reason rather
than a backlog position: `28-SPRINT-TICKETS` schedules no server-side home for them, and
browser storage is barred from holding authoritative state by the workspace lint rule
(15-AI-EXECUTION-HANDBOOK §8), so a view saved in one browser would lie about existing
everywhere else. The rule counts whole/half/zero; a named part of the scope is absent, so
WEB-002 stays **half 6.5** and the totals stay 26 of 70 and 204.5 of 583 — 35.1%. The work is
real; the numerator is not where it shows.

8 new web cases: the cursor and its warning's retirement, the sort cycle with `aria-sort`,
the preview-then-send with per-version PATCHes and the unretried 409, the ceremony-free
narrowing, the three badge states, and the inbox's "loaded" heading.

---

## Verification actually run — 2026-08-30, WEB-003 first half, same session

The whole chain again, one uninterrupted background run on the tree commit `ddf1345` left —
the same session as the CHAT-003 verification below, run after the chat screens were written.
**Green on the first attempt.**

| Gate                        | Result                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`         | Clean                                                                                                                   |
| `pnpm typecheck`            | **Done** — five projects, and the new screens compiled clean on their first pass                                        |
| `pnpm lint`                 | Clean after one unused import was removed                                                                               |
| `pnpm test`                 | **840 passed across 40 files.** Up from 831 and 39: the 9 new cases are `chat-flow.test.tsx`, in `apps/web` (319 → 328) |
| `pnpm test:db`              | **24 files, 705 passed, 29 skipped (734)** — unchanged, as it must be: this ticket added no API and no table            |
| `pnpm audit:design`         | **172/172 screen IDs across 29 artifacts, 0 missing**                                                                   |
| `pnpm format:check` (again) | Clean                                                                                                                   |
| Leaked `mysqld`             | **None**, checked after the suite exited                                                                                |

Three of the nine web cases failed on their first solo run and all three were the _tests_'
fault, not the screens' — ambiguous queries where two "Project" selects, two "Send" buttons or
an option and a hint share a name. Each was fixed by scoping the query to the section, form or
row it meant, the assertions untouched.

---

## WEB-003 first half — the channel a person can read, in a browser

**TM-06, TM-08 and TM-09** against the API CHAT-001 through CHAT-003 delivered. Commit
`ddf1345`. The plan marks WEB-003 "13→split"; this is the declared first half, and the second
half is named below rather than implied.

- **The channel list** (`/[orgSlug]/chat`, the rail's Chat orb) — channels grouped under their
  project, archived ones on request, and a create form that asks for the project first,
  because every conversation in this system is a project channel.
- **TM-06, the channel** (`/[orgSlug]/chat/[conversationId]`) — the transcript oldest-first,
  authors as short ids (there is no people directory to look names up in, and "Someone" on
  every row would make a transcript unreadable), rich text rendered through CHAT-002's closed
  grammar as React elements — no HTML is ever parsed, a message that says `<script>` renders
  as those nine characters — moderated messages as tombstones that keep the removal visible,
  and "edited" with the full history behind it.
- **The composer that cannot double-post.** It mints a `clientGeneratedId` when a send starts
  and keeps it until that send succeeds; a failed send leaves the text in the box and the id
  in hand, so pressing Send again replays the same id and the API's dedupe answers with the
  original. The test fails the first send on purpose and proves the second carries the same id.
- **TM-08, the thread pane** — the shell's detail lens: source pinned, replies read with
  `parentMessageId` as a query parameter (never filtered out of the channel in the browser),
  its own composer, keyboard order by DOM order.
- **TM-09, the convert dialog** — title defaulted from the message's first line, audience
  defaulted internal with the client warning shown before a widening choice is submitted, the
  project stated as a fact rather than offered as a choice, no owner and no date invented, and
  `created: false` rendered as "Already converted" with the existing item linked — INT-07's
  answer, drawn.
- **Honest absences**: reactions, saves, quote-to-decision, pins, presence and live updates
  have no endpoint; the rich-text _composer_ (the API accepts `bodyRich`; a toolbar emitting
  the grammar is its own piece of work) and transcript paging are second-half work; TM-07
  direct messages have no API at all — every one named in `BackendPending`, none drawn as a
  dead button.

9 web cases including an axe pass over the whole channel screen. The ticket counts **half
(6.5 of 13)** by the progress rule: TM-06, TM-08 and TM-09 are built and tested; the named
remainder is absent.

---

## Verification actually run — 2026-08-30, the CHAT-003 verification session

CHAT-003's code and tests landed last session (`e1e4c46`) with its own suite green (14/14,
first try) — but the full chain was **deliberately stopped before it started** so that session
could end safely, and no results existed for it. This session's first act after the
reconciliation was to run it fresh: the whole chain, one uninterrupted background run on the
tree exactly as `e1e4c46` left it, **green on the first attempt**. 985 seconds end to end.

| Gate                        | Result                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`         | Clean — the only edit between `e1e4c46` and the run was the fourteenth-reconciliation record, formatted before the chain started      |
| `pnpm typecheck`            | **Done** — five projects                                                                                                              |
| `pnpm lint`                 | Clean, no output                                                                                                                      |
| `pnpm test`                 | **831 passed across 39 files** — unchanged from CHAT-002's run, because CHAT-003 added no unit cases; its proofs need a real database |
| `pnpm test:db`              | **24 files, 705 passed, 29 skipped (734).** Up from 23 files and 688 + 27. The database suite alone took 886 s                        |
| `pnpm audit:design`         | **172/172 screen IDs across 29 artifacts, 0 missing**                                                                                 |
| `pnpm format:check` (again) | Clean                                                                                                                                 |
| Leaked `mysqld`             | **None**, checked before the run (none to kill) and after the suite exited                                                            |

Engine: the embedded **MySQL 8.0.45**. The database arithmetic:
`chat-003-message-to-work.db.test.ts` contributes 14 passed, the concurrency race among them;
`schema.db.test.ts` generated three more (77 → 80) for `message_work_links`' columns,
nullability and types without a line being written; 688 + 14 + 3 = 705. The two skips added to
the old 27 are the two new `least-privilege.db.test.ts` cases — the runtime credential's
INSERT-only grant on the link table — which skip like the rest of that file on the default
path, with no `tmanage_app` credential to test ADR-0001 layer 2 against. Skips, reported as
skips.

---

## CHAT-003 — a message becomes work, exactly once

**Message-to-work conversion** — `09-MVP-PRD` FR-02, `27-TEST-CATALOG` INT-07. Committed as
`e1e4c46` last session; verified by the chain above this session. The row's whole scope is
built and proved, so the ticket moves to `tested` here rather than when it was written.

- **The idempotency is the relation itself.** `message_work_links` (migration
  `0009_message_work_links.sql`) is unique on `(organization_id, message_id)` **and** on
  `(organization_id, work_item_id)`, and that unique key _is_ INT-07's "one linked work item
  on retry": a retry — or the loser of a genuine race, which the suite fires for real — gets a
  duplicate-key refusal translated into **200 with the winner's conversion**, and the losing
  transaction is rolled back whole, its second work item included. No `idempotency_records`
  machinery; a relation that is naturally one-to-one needs none.
- **The link is immutable the way FR-02 asks.** The runtime credential holds an INSERT-only
  grant on the table, and a trigger refuses `UPDATE` for every credential — a conversion can
  be recorded and never rewritten.
- **The route** is `POST …/conversations/:conversationId/messages/:messageId/work-items`:
  `conversation.read` plus channel membership to see the message, `work.create` on the
  conversation's project to file work. The project is **not choosable** — it is the
  conversation's, because a conversion that could re-home the work would make the source link
  a lie at the moment of writing it. 201 when converted here, 200 with the existing conversion
  when already converted.
- **Defaults are FR-02's.** The title defaults to the message's first line; the audience
  defaults to `internal` — external sharing never inherits internal visibility automatically.
- **A moderated message refuses conversion with a 409** — its body is withheld, and a work
  item titled from withheld content would leak it.
- **The audit row reuses `work_item.created`** with metadata key `converted_from_id` — not
  `source_message_id`, because `assertSafeAuditMetadata` forbids any key whose underscore
  segments include `message`, the hazard CHAT-001 recorded.
- `toWorkItemView` is now exported from `work-items.service.ts` so the conversion answers with
  the same projection a plain creation would. `message_work_links` was registered in
  `TENANT_TABLES` **in the same commit** — the omission the drift gate caught mid-chain last
  time was not repeated.

14 database cases over real HTTP, the concurrency race included. Two least-privilege cases
(skipped without the credential, like that whole file).

---

## Verification actually run — 2026-08-29, the CHAT-002 session

The whole chain, one uninterrupted background run on the tree CHAT-002 left behind. It took
**four attempts to get a green run**, and the reasons are themselves the record — see the two
subsections below.

| Gate                              | Result                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format` then `format:check` | Clean, before anything below was recorded                                                                                  |
| `pnpm typecheck`                  | **Done** — five projects                                                                                                   |
| `pnpm lint`                       | Clean, no output                                                                                                           |
| `pnpm test`                       | **831 passed across 39 files.** Up from 802 and 38: the 29 new cases are the rich-text sanitiser's, in `packages/domain`   |
| `pnpm test:db`                    | **23 files, 688 passed, 27 skipped (715).** Up from 22 files and 662 + 23. Duration of the green run's whole chain: 1264 s |
| `pnpm audit:design`               | **172/172 screen IDs across 29 artifacts, 0 missing**                                                                      |
| `pnpm format:check` (again)       | Clean                                                                                                                      |
| Leaked `mysqld`                   | **None**, checked after the suite exited                                                                                   |

Engine: the embedded **MySQL 8.0.45**. The database arithmetic:
`chat-002-rich-text.db.test.ts` contributes 23 passed; `schema.db.test.ts` generated three more
(74 → 77) for `message_revisions`' columns, nullability and types without a line being written;
662 + 23 + 3 = 688. The four skips added to the old 23 are the four new
`least-privilege.db.test.ts` cases, which skip like the rest of that file on the default path —
no `tmanage_app` credential to test ADR-0001 layer 2 against. Skips, reported as skips.

### Chain attempts 1–3, and what each one was

1. **Attempt 1 failed in `apps/web`'s unit suite** — `ON-01`'s axe case timed out at 30 s and a
   `work-flow.test.tsx` lookup missed its 1 s Testing Library window. Every failing file passed
   alone immediately afterwards (87/87 in 36 s), under ~54% external CPU load from outside the
   repository.
2. **Attempt 2, on a quiet machine, failed on `ON-01`'s axe case again** — the fourth
   consecutive full-suite run to hit it while it passed every time alone. That stopped being a
   flake and became a measurement: the pass takes **9.6 s running alone on an idle machine**
   (the 600-option timezone list the config comment already documents), and sixteen jsdom
   workers side by side multiply it past any 30 s ceiling.
3. So commit `a499547` raised two ceilings **from measurement, with the assertions untouched**:
   `testTimeout` 30 s → 90 s in `apps/web/vitest.config.ts` (axe still walks every node; every
   violation still fails the case), and Testing Library's `asyncUtilTimeout` 1 s → 5 s in
   `tests/setup.ts` — the exact decision the WORK-001 session recorded and left "for a session
   that can decide it on purpose". A genuinely missing element now costs 5 s to report instead
   of 1 s, which is the price, named in the comment.
4. **Attempt 3 then ran the unit suite fully green — 319/319 in `apps/web` — and failed in
   `test:db` on two cases of `tenant-isolation.db.test.ts`**: `message_revisions` carries an
   `organization_id` column and was not registered in `TENANT_TABLES`. That is the drift gate
   doing precisely what its comment promises ("a new module migration cannot quietly opt out of
   the guard"), and it caught a genuine omission in CHAT-002. Commit `6076ebe` registered the
   table as tenant-owned; attempt 4 is the green run above.

---

## CHAT-002 — what a message may say, and what it said before

**Sanitized rich text and the edit history** — the two decisions CHAT-001 deliberately left
open, decided. Commits `24c962e` (the ticket), `a499547` (the test-harness ceilings) and
`6076ebe` (the guard registration its own chain run demanded).

### What markup is admissible: a closed JSON grammar, not HTML with tags removed

`packages/domain/src/value-objects/rich-text.ts`. A document is a tree of typed nodes —
paragraphs, code blocks, quotes, two list kinds, hard breaks; text runs carrying bold, italic,
strike, code, and links whose scheme must be `http`, `https` or `mailto`. An HTML sanitiser is
a parser racing an attacker's parser, and every divergence between the two is a bypass; a
validator over a closed grammar has no second parser to disagree with, and no place where
markup is text. No HTML is ever parsed or stored. `javascript:` in any spelling — case games,
whitespace, tab smuggling — dies at the scheme allowlist, because WHATWG URL parsing normalises
before the comparison. Complexity is bounded before content is judged (`04-SECURITY-PRIVACY`
§6's "complexity limits"): 1,000 nodes, depth 8, 16,000 characters of text — the same ceiling
as a plain message, because a rich message is not entitled to say more.

### Where sanitising happens: the write boundary, refusing rather than repairing

The precedent is `assertSafeAuditMetadata`. `ConversationsService.resolveContent` runs
`sanitizeRichText` before anything is read or written; an inadmissible document is refused
whole — **422, the path to the first offence**
(`doc.content[0].content[0].marks[0].href`), nothing stored, no sequence number consumed.
Nothing is stripped, because a repair the author never saw is how a sanitiser and a renderer
come to read the same message differently. The plain `body` of a rich message is **derived**
from the sanitised document (`richTextToPlainText`), never accepted from the caller, so
`messages.body` and the new `messages.body_rich` cannot disagree about what was said. A caller
sends exactly one of `body` and `bodyRich`; both is refused as a request whose two versions are
free to disagree.

### The edit history: engine-authored, so the application cannot not-write it

`message_revisions` (migration `0008_message_rich_text.sql`) holds the body a message had
before each change, and `trg_messages_record_revision` is what writes it — a trigger, firing
with its **definer's** privileges, archiving the displaced body and forcing `edited_at`
forward whenever either body column changes, for any session. `users.sql` grants the runtime
credential **nothing** on the table (`SELECT` is database-wide), so the application cannot
forge a revision, cannot suppress one, and cannot delete one; a direct SQL rewrite of a
message still leaves a trail, and the suite proves exactly that with a raw `UPDATE` through
the admin connection. A second trigger refuses `UPDATE` on revisions for every credential.

Two absences are deliberate. **No CHAR(36) id**: the rows are engine-authored, the engine has
no UUIDv7, and MySQL's `UUID()` is a v1 that would silently break the convention it appeared
to follow — `(organization_id, message_id, revision_no)` is what a revision _is_. **No
`edited_by_user_id`**: only a message's author may edit it, so the editor is
`messages.author_user_id`, already recorded, and a column filled in by the very session whose
honesty is in question would be weaker than the derivation it replaced.

Moderation and history interact the way CHAT-001's model forces: taking a message down
withholds every superseded body exactly as it withholds the current one — a removal that left
every earlier version readable would not have removed anything — while the revisions' count
and times survive, because "edited twice, then removed" is part of the record. The rows still
hold the bodies; the projection is what withholds them, which is the moderation ledger's
distinction between hiding and erasing.

### The surface

One new route — `GET …/conversations/:conversationId/messages/:messageId/revisions`, readable
by anyone who may read the channel, because an edit is visible to the room and what it changed
from is the room's to see. `bodyRich` on post and edit; a rich retry under the same
client-generated id dedupes to the original with a 200. An edit that changes nothing writes no
revision and no `edited_at` — the trigger compares before it records.

29 unit cases on the sanitiser (every `javascript:` spelling, unknown nodes/marks/keys,
duplicate marks, the three complexity ceilings, the derivation). 23 database cases over real
HTTP — concurrent edits numbering without loss, the direct-SQL trail, the moderation
interaction, tenant isolation on the history. Four least-privilege cases (skipped without the
credential, like that whole file): the runtime user cannot INSERT, UPDATE or DELETE a
revision, and its ordinary UPDATE on `messages` still produces the revision it could never
write itself.

### Named gaps in CHAT-002, carried deliberately

- **Mentions, attachments, reactions** — `09-MVP-PRD`'s Collaboration scope lists them beside
  rich text; none is in CHAT-002's row and none is built. A mention needs a user-id-bearing
  inline node and a validation read the sanitiser deliberately does not do — it is pure, and
  keeping it pure is what makes it reviewable.
- **No renderer.** Nothing draws a rich document yet; that is WEB-003's screen. The renderer
  owns contextual output encoding — the other half of §6's sentence — and the grammar
  guarantees it will never receive markup-as-text.
- **SEC-08 proper is a browser test** — stored XSS through real screens, CSP. Not runnable in
  jsdom; the storage half is proven, the DOM half waits for the browser harness the UI-001
  gaps already name.
- **`body_rich` is NULL for every CHAT-001-era row** and stays NULL. Not a backfill
  candidate: a plain body does not say which of its characters were meant as emphasis.

---

## Verification actually run — 2026-08-26, the CHAT-001 session

The whole chain, in order, on the tree CHAT-001 left behind.

| Gate                              | Result                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm format` then `format:check` | Clean, before anything below was recorded                                                                         |
| `pnpm typecheck`                  | **Done** — five projects                                                                                          |
| `pnpm lint`                       | Clean, no output                                                                                                  |
| `pnpm test`                       | **802 passed across 38 files** — unchanged. CHAT-001 adds no unit case: everything it asserts needs a real server |
| `pnpm test:db`                    | **22 files, 662 passed, 23 skipped (685).** Up from 21 files and 608 + 22. Duration 1166 s                        |
| `pnpm audit:design`               | **172/172 screen IDs across 29 artifacts, 0 missing**                                                             |
| `pnpm format:check` (again)       | Clean                                                                                                             |
| Leaked `mysqld`                   | **None.** `ps` showed no `mysqld` after the suite exited                                                          |

Engine: the embedded **MySQL 8.0.45**. The 23 skips are `least-privilege.db.test.ts` on the
default path (21), one in `req-001` and one in `chat-001` — all three files skip the same thing
for the same reason, which is that the default path has no `tmanage_app` credential to test
ADR-0001 layer 2 against. They are skips and are reported as skips.

### The arithmetic of the database count, because it does not add up on its own

CHAT-001's own file contributes **45 passed and 1 skipped**. 608 + 45 is 653, and the suite
reports 662. The missing nine are **not** this ticket's assertions: `schema.db.test.ts`,
`tenant-isolation.db.test.ts` and `migrator.db.test.ts` generate cases from
`information_schema` and from the migrations directory, so three new tables and one new
migration produced nine more cases without a line being written for them. `tenant-isolation`
went from 44 to 45 and `migrator` from 15 to 16 for exactly that reason.

That is the drift gate working as designed: a module that added tables and forgot to register
them in `TENANT_TABLES` would have failed there rather than shipped.

---

## CHAT-001 — the room the studio talks in, and the number that says who spoke first

**`13-ENGINEERING-EXECUTION-SPEC` §5 has named `conversations`, `conversation_memberships` and
`messages` since the plan was written, and none of them existed.** Five tickets built a client
request loop that works at both ends and cannot hold a conversation: a manager asks one
question and the client is told to reply however they normally reach the studio.

### What shipped

- **`0007_conversations.sql`** — three tables and four triggers.
- **`apps/api/src/modules/conversations/`** — repository, service, controller, module.
- **Twelve routes** under `/v1/organizations/:orgSlug`: list, read, create, rename and archive a
  channel; list, add and remove its members; list, post, edit and take down messages.
- **Four audit actions** in `packages/domain`: `conversation.created`,
  `conversation.member_added`, `conversation.member_removed`, `message.deleted`.
- **`apps/api/test/chat-001-conversations.db.test.ts`** — 45 cases and 1 skip over real HTTP.

### Project channels only, and the omission is the decision

`22-SCREEN-BY-SCREEN` §4 has TM-06 project channels **and** TM-07 direct/group messages. This
ticket builds the first: `conversations.project_id` is `NOT NULL`.

The reason is authorization rather than effort. `conversation.read` is relation-gated in
`packages/domain/src/policies/authorize.ts`, and the relation it checks is **project
membership**. A conversation with no project has no relation for the evaluator to check, so
every internal principal holding the capability would pass — the right answer for a project
channel and precisely the wrong one for a direct message between two people. TM-07 needs a
relation the evaluator does not have, and adding one inside a storage migration is how an
authorization core acquires a rule nobody reviewed.

There is deliberately **no `kind` column** carrying one legal value, for the reason
`client_requests.category` was left as free text: a vocabulary no screen agreed to is worse
than no vocabulary.

### Threads are one level deep, and InnoDB is what refuses the second

TM-08 draws a thread as a source message with replies. It does not draw a reply to a reply, and
a tree would make "the thread pane" an unbounded recursion rather than a panel.

Enforcing that needs a fact about the **parent** row, which a trigger cannot read — MySQL will
not let a trigger query its own subject table. So the fact is carried in the key instead.
`depth` is 0 for a root and 1 for a reply, `(organization_id, id, depth)` is unique, and a
reply's foreign key names `(organization_id, parent_message_id, 0)`, so the parent must be a row
whose depth is 0. `parent_depth` exists only to give that foreign key its third column.

The redundant column is the price of an invariant InnoDB holds rather than one the service
promises. ADR-0001 layers 3 and 4 are application-side; this survives them, and a test proves it
by writing a nested reply straight to the database and watching it fail.

The repository does **not** read the parent first to check its depth. A read-then-write check is
a race and a foreign key is not.

### The sequence number is allocated, never supplied

`23-ERD` §4 requires `(organization_id, conversation_id, sequence_no)` to be unique and INT-08
requires it to be monotonic per conversation. `conversations.next_sequence_no` is the allocator:
a message insert takes that row's lock with `SELECT ... FOR UPDATE`, writes the value it read,
and increments it, all inside the transaction that inserts the message.

`MAX(sequence_no) + 1` was the obvious alternative and it is wrong under concurrency without a
lock of its own — and the row it would have to lock is the row it is trying to insert. The
unique key is the backstop either way; with the counter it is a backstop rather than the
mechanism.

**Proved rather than asserted.** Ten posts fired concurrently at one channel come back holding
exactly 1 through 10. A single writer would have passed with either design, which is why the
suite does not test one.

There is no `sequenceNo` field on the input type or on the request body, so there is no path
that numbers a message by hand. A body that supplies one is ignored, and a test says so.

### Two gates, and the narrower one is not the evaluator's

`authorize()` runs first and is authoritative. Then the service requires that the acting
principal be a **member of the conversation**, or hold organization-wide scope.

The order is the whole of the rule. No amount of conversation membership admits a client
principal or a suspended member, because the evaluator refuses those before any of this
module's code runs; the membership check can only ever take access away. A gate that could add
access would be a second authorization system, which `25-AUTH-AND-TENANT-ISOLATION` §4 forbids
policy from being.

It earns its keep immediately: a project can hold more than one channel, and a person on the
project is not thereby in every room on it. The suite proves a project member outside a channel
gets 404 and sees it in no list, and that an Owner reads it without ever being added.

The same rule runs backwards when somebody is **added**: the person being added must already be
on the project, or a channel membership would be a way to grant project access the evaluator
would have refused.

### What this ticket does not do, stated because the motivation suggests otherwise

**CHAT-001 does not let a client reply to a clarification.** No client role holds
`conversation.read`, `conversation.write` or `conversation.moderate` — `12-PERMISSION-MATRIX` §2
gives them no internal read at all, and `capabilities.ts` records the absence as load-bearing.
`authorize()` refuses them twice: once on the ceiling and once on the independent internal-only
guard, and the suite checks all three verbs come back 403.

This builds the room the studio talks in. A client-facing thread needs a projection and an
evaluator relation that do not exist; it is a named gap below rather than something smuggled in
behind a capability nobody granted.

### A message is not an audit event; taking one down is

Three actions record conversation membership and creation, and a fourth records moderation.
**Posting a message records nothing**, and the suite asserts the absence so a later author does
not "fix" it.

§12 lists the changes that are security events, and somebody speaking in a channel they belong
to is not one. A row per message would be an audit table growing faster than the table it
audits. `24-EVENT-CATALOG` does name `message.created.v1` — as a **durable event** for realtime,
mentions and search, which is a different mechanism. (This line read "one nothing publishes yet
because `PLAT-004`'s relay is unwritten" until 2026-08-30; the relay now runs and `postMessage`
publishes it, body-free, in the same transaction.)

Moderation is somebody exercising authority over what another person said, which is exactly
§12's subject.

### Nobody can rewrite somebody else's words

A moderator may take a message down. **Only its author may edit one** — not a Manager, not an
Owner, and the suite checks the Owner specifically, because organization-wide scope reaches
everything else in this system.

Moderation keeps the row: `users.sql` grants no `DELETE` on `messages`, so the absence is
structural rather than the repository's restraint. The projection returns `body: null` once a
message is taken down rather than the text with a flag beside it — the point of a removal is
that people stop reading it, and a flag leaves that to whoever writes the screen.

### Two defects, both found by this ticket's own suite

1. **Every duplicate and every bad thread parent arrived as a 500.** Drizzle wraps anything
   thrown during execution in a `DrizzleQueryError` whose `code` is its own, and
   `TenantDatabase` strips that only at the transaction boundary — which is outside every
   `catch` in this repository. `OrganizationsRepository` documented this trap when TEN-001
   landed and the helper it needs, `unwrapQueryError`, already existed. Six failing cases;
   `driverErrorCode` now unwraps first and also falls back to `errno`, so MariaDB's spelling
   works too.
2. **Every moderation was a 500, and the reason is a rule this codebase wrote against itself.**
   The audit metadata gate refuses any key whose underscore-separated segments include
   `message`. The flag describing a moderation was called `own_message` — so the key that would
   have described a take-down could not be written **in a take-down's audit row**. Renamed
   `actor_is_author`. AUD-001's own notes anticipated this shape of collision (`subject_user_id`
   was renamed for the same reason) and recorded the resolution as renaming the key rather than
   relaxing the denylist. That is what was done.

### Two divergences from the pack, recorded rather than resolved

1. **`13-ENGINEERING` §3 writes the route as `POST /v1/conversations/{id}/messages`** and this
   controller mounts it under the organization slug like every other route in the application.
   An unprefixed path would have no slug for `TenantContextGuard` to resolve, and every route
   that exists would have to move for the sake of one that does not. The pack's form reads as
   shorthand rather than a decision.
2. **`07-DATA-MODEL` §2 names `Thread` as an entity** and `13-ENGINEERING` §5's table list does
   not have one. There is no `threads` table here: a thread is a root message and the messages
   whose `parent_message_id` names it. The two documents disagree and the table list is the one
   that enumerates storage.

### Named gaps in CHAT-001, carried deliberately

1. **TM-07 direct and group messages are not built.** The reason is above and it is an
   authorization gap, not a schema one. Closing it needs an evaluator relation for a
   conversation with no project.
2. **No screen.** `WEB-003` is "channel/thread/convert dialog" and is a separate ticket. TM-06,
   TM-07, TM-08 and TM-09 all have an API now and no browser.
3. **Bodies are plain text.** `CHAT-002` is "create/read messages and sanitized rich-text" and
   is the ticket that decides what markup is admissible. Storing rich text first would mean
   storing it before anything could sanitise it.
4. **Edit history is a column, not a table.** `edited_at` records _that_ an edit happened. TM-06
   lists "edit history" among the message actions and the history itself has no storage.
5. **No outbox row.** `24-EVENT-CATALOG` names `message.created.v1` and `message.converted.v1`;
   nothing emits either, because `PLAT-004`'s relay is unwritten and `apps/worker` is still an
   empty directory. `CHAT-003` is the ticket that needs the second one. **Closed 2026-08-30:**
   PLAT-004's producers now emit both, and the relay drains them.
6. **No mentions, reactions, pinned context, presence or read state.** TM-06 lists all of them.
   `conversation_memberships` has no `last_read_sequence_no`, so there is nothing for an unread
   count to read; that belongs with `INBOX-001`.
7. **A channel-shared-with-a-client has no representation.** TM-06's "client-shared channels use
   persistent external audience banner" needs an audience on a conversation and a projection
   behind it. No column was added, because a column with no reader and no enforcement is the
   kind of thing this file has had to correct before.
8. **Archiving a channel is not cascaded.** An archived channel refuses posts and hides from the
   default list; its messages stay readable. Nothing archives a channel when its project is
   archived, because nothing archives a project either.

---

## Verification actually run — 2026-08-26, the ticket-name correction pass

The whole chain, in order, on the tree the correction pass left behind. Nothing below is
carried over from a previous run.

| Gate                              | Result                                                                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format` then `format:check` | Clean. `pnpm format` rewrapped `implementation-status.md` and three screens before anything was recorded                                                             |
| `pnpm typecheck`                  | **Done** — five projects. One real failure on the way: the new gate indexed a regex capture group without narrowing it, and `noUncheckedIndexedAccess` caught it     |
| `pnpm lint`                       | Clean, no output                                                                                                                                                     |
| `pnpm test`                       | **802 passed across 38 files** — 25 config, 102 domain, 106 ui, 250 api unit, 319 web. Two more than the previous session's 800, which are this pass's two new cases |
| `pnpm test:db`                    | **21 files, 608 passed, 22 skipped (630).** Identical to the previous session's figure, which is the point: renaming a test file did not change what runs            |
| `pnpm audit:design`               | **172/172 screen IDs across 29 artifacts, 0 missing**                                                                                                                |
| `pnpm format:check` (again)       | Clean — `audit:design` rewrites `docs/design/design-source-audit.md` and is Prettier-idempotent                                                                      |
| Leaked `mysqld`                   | **None.** `ps` showed no `mysqld` after the suite exited                                                                                                             |

Engine: the embedded **MySQL 8.0.45** from `C:\Program Files\MySQL\MySQL Server 8.0`. The 21
skips are `least-privilege.db.test.ts` on the default path, which has no `tmanage_app`
credential, plus one in `req-001` for the same reason. They are skips and are reported as skips.

### Two things about this run that are worth the next session's attention

1. **`pnpm test:db` took 2123 s — about 35 minutes — against a usual 12 to 14.** The cause was
   this session's own doing rather than the suite's: three `pnpm test` runs were started while
   the database suite was already in flight, and each spawns a worker per core. The results are
   sound — no source file was edited during the run, which is the rule that actually matters —
   but the wall time is not a baseline. **Do not run another suite while `test:db` is running.**
2. **`apps/web`'s suite flaked once, under that same contention.** `triage-flow.test.tsx` failed
   a `findByRole` whose implicit timeout is 1 s while the file's own `testTimeout` is 30 s; the
   run reported `Timeout calling "onTaskUpdate"` and 691 s of test time against a normal 120 s.
   It passed alone immediately afterwards and passed twice more in full runs. Recorded as a
   flake rather than a defect **and not fixed**: the gap between Testing Library's 1 s default
   and vitest's 30 s is real, and closing it means either raising `asyncUtilTimeout` globally or
   leaving the suite sensitive to machine load. Raising a timeout to make a red run green is the
   thing this file's constraints forbid doing casually, so it is named here for a session that
   can decide it on purpose. The new `ticket-ids.test.ts` was moved to the `node` environment to
   stop it paying several seconds of jsdom setup and adding to the contention it found.

---

## Verification actually run — 2026-08-26, the SEC-001 session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`815 s` wall (13 m 35 s), **exit 0**.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                                                  |
| `typecheck`              | Clean across five projects                                                                                          |
| `lint`                   | Clean                                                                                                               |
| `test` (unit)            | **800 passed**, 35 files — config 25, domain 102, ui 106, **api 250**, web 317. Was 791; nine new interceptor cases |
| `test:db`                | **608 passed, 22 skipped**, **21 files**, **729.30 s**. Was 592/22 across 20; one new suite, 16 cases               |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                                               |
| `format:check` (closing) | Clean                                                                                                               |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run                                                           |

`next build` was **not** re-run and no claim is made about it. SEC-001 adds no route to
`apps/web`; the twenty-two routes recorded in the WEB-005 section are unchanged.

---

## SEC-001 — the rule that had no enforcement point, and the grid that had no operations

`28-SPRINT-TICKETS` §7: `SEC-001 client projection/query policies and cross-tenant isolation
corpus`, 8 points, the last ticket of Sprint 4.

Two things were missing, and both were created by work landing around a rule rather than
through it.

### 1. `findForbiddenClientFields` had no caller

`25-AUTHORIZATION-AND-TENANT-ISOLATION` §7 lists the fields a client must never see — "internal
notes, private comments/messages, estimates/cost/margin, staff evaluation, internal risk
rationale, security metadata, other-client identities, hidden custom fields, unreleased versions,
and internal file keys" — and `packages/domain` has expressed that list as
`findForbiddenClientFields` since the audience policy landed.

**Nothing in the application called it.** A rule with no enforcement point holds exactly as long
as everybody remembers it, and §7's own closing sentence — "Never implement client access as
`serializeInternalObject(); delete fields`" — describes the mistake somebody makes at four in the
afternoon.

`ClientProjectionInterceptor` is that enforcement point. It inspects every response on a path
whose segments include `portal` and refuses one carrying a forbidden key.

Three decisions inside it are worth the words:

- **It refuses rather than filters.** A first draft stripped the offending keys and let the
  response through. That was wrong: a projection that quietly loses a field is one whose author
  never learns, and the next field they add — one this list does not name — travels all the way
  to the client. The refusal is a **500**, because a response the interceptor objects to is a
  programming error and not anything the caller did.
- **It is global, not a decorator on `PortalController`.** A decorator is one a new client-facing
  controller can be written without. `/portal` is already what the API treats as the client
  boundary — that controller's own note calls it "a path of its own" and a security property
  rather than a routing preference — so matching the path means a new portal route is covered by
  existing.
- **It is defence in depth and says so.** The control is that `PortalService` and
  `ClientRequestsService` build client views field by field and never select an internal row.
  This is the check that would catch the day somebody stopped doing that.

The field **name** travels on the error's `auditCode`; the value never does. Names are keys of a
fixed list in `packages/domain`, and a test asserts the value is absent from both the message and
the code.

### 2. §11's grid is over operations, and the corpus was over tables

`tenant-isolation.db.test.ts` is thorough and it was written **before any client-facing surface
existed**: its 45 cases describe a system with no portal and no client request in it. §11 asks
for something that file cannot express — "Every operation is tested for: correct internal project;
same organization/different project; same organization/different client; different organization;
suspended membership; expired client membership; direct-ID enumeration; changed role after
session; archived/deleted object" — and the operations in question are HTTP requests made by a
client principal.

`sec-001-client-projection.db.test.ts` is that grid. The three client-reachable read operations
are written **as data**, so a new client endpoint has an obvious place to be added and the grid
cannot cover two of three and look complete.

The two suites overlap deliberately and prove different things: remove the query guard and
`tenant-isolation` fails; keep the guard and let `PortalService` start returning the internal
record, and only SEC-001 does.

### The three holes it closes, each created since the storage corpus was written

1. **`client_requests` had no cross-boundary case.** It was registered in `TENANT_TABLES` and the
   registration was asserted — but nothing drove a client's read of one across a boundary and
   watched it refuse.
2. **`clientOrganizationName` had no database case at all.** The WEB-005 verification section
   said so in as many words: it was proved by a web test over a mocked response, which proves
   the screen renders it and not that the API produces it. It now has three, one of which first
   asserts that a `manager` really is refused `GET client-organizations` — because the whole
   reason the name is on the projection is that this call fails for them.
3. **The client-to-client boundary was proved endpoint by endpoint** across three suites. It is
   now enumerated once, alongside every other §11 condition.

### What the grid found

**Nothing.** All sixteen cases passed on their first run, and that is worth stating rather than
glossing: the controls they exercise were built by `TEN-002`, `CLIENT-002` and `REQ-001` and each
was tested when it landed. What SEC-001 adds is that they are now checked **together, as one
enumerated rule**, so a future change that satisfies one endpoint's test and breaks the boundary
somewhere else has somewhere to fail.

A corpus finding nothing on the day it is written is the expected outcome. It earns its place on
the day somebody changes a projection.

### Named gaps in SEC-001, carried deliberately

1. **§11 lists conditions this system has nothing to test.** "Stale cache/search", "delayed job",
   "realtime subscription before revocation" — there is no cache, no search, no job runner and no
   websocket. They are absent rather than skipped, and they belong to the tickets that build
   those things.
2. **§11 also lists surfaces that do not exist:** "exports, search, notifications, websockets,
   files, jobs". The grid covers reads, writes and the client projection, which is what exists.
3. **The "changed role after session" case proves less than its name.** A client viewer keeps
   `client_request.submit` — `12-PERMISSION-MATRIX` §2 says "Policy" for that row — and the
   capability a viewer actually loses is `approval.decide`, for which there is no endpoint. What
   the case proves today is that the role is **re-read per request** rather than carried on the
   session; the sharper version arrives with `APPR-001`.
4. **The interceptor cannot see a field this codebase has not named.** `FORBIDDEN_CLIENT_FIELDS`
   is §7's list transcribed, and a leak through a key nobody thought of passes it. It is a
   backstop for the known list, not a general-purpose filter, and the field-by-field projections
   remain the actual control.
5. **No mutation test on the interceptor.** Other controls in this codebase are proved by
   breaking them and watching a test fail; this one is proved by nine unit cases that force a
   body it must refuse. Forcing a real projection to leak would mean shipping a leak to prove it
   is caught, and that is the wrong trade.

---

## Verification actually run — 2026-08-26, the WEB-005 session

The full chain, in one uninterrupted background run so that nothing was edited underneath it.
`721 s` wall (12 m 1 s), **exit 0**.

```bash
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm test:db && pnpm audit:design && pnpm format:check
```

| Gate                     | Result                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `format:check` (opening) | Clean. Run **after** `pnpm format`                                                                                         |
| `typecheck`              | Clean across five projects                                                                                                 |
| `lint`                   | Clean                                                                                                                      |
| `test` (unit)            | **791 passed**, 35 files — config 25, domain 102, ui 106, api 241, **web 317**. Was 770 across 34; one new suite, 21 cases |
| `test:db`                | **592 passed, 22 skipped**, 20 files, **631.89 s**. Unchanged: WEB-005 adds no database surface                            |
| `audit:design`           | **172/172** screen IDs across 29 artifacts, 0 missing                                                                      |
| `format:check` (closing) | Clean                                                                                                                      |
| Leaked `mysqld`          | **None.** Checked with `Get-Process mysqld` after the run                                                                  |

`next build` was run separately and succeeded: **twenty-two routes**, was twenty. The two new
ones are `/[orgSlug]/work/requests` and `/[orgSlug]/work/requests/[requestId]`.

The database count is unchanged even though this session changed the API: `clientOrganizationName`
was added to the internal projection and **no database case asserts it**, because every existing
case reads the fields it was written for and none of them reads that one. It is covered by the
web suite, over a mocked response, which proves the screen renders it and does **not** prove the
API produces it. That is a real hole and it is named here rather than counted as coverage.

---

## WEB-005 — the screen the studio answers on

`REQ-001` and `REQ-002` gave the studio everything: a queue, a clarification, a decline with a
client-safe reason, and an acceptance that commits the work in one transaction. **None of it had
a screen.** A client could ask for something in a browser and nobody at the agency could answer
without an HTTP client — a worse position than the client had been in that morning, when they at
least had a portal to read.

`28-SPRINT-TICKETS` §7: `WEB-005 manager triage screen and schedule impact`, 8 points, depending
on REQ-002.

### What shipped

| Piece                                       | What it is                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `RequestInboxScreen`                        | `REQ-01`. Counts by bucket, a filter that stays on the page, a table sorted by age          |
| `RequestTriageScreen`                       | `REQ-02` and `REQ-03` — the four outcomes, and the commitment review before a promise       |
| `lib/triage-presentation.ts`                | The **internal** vocabulary of §6's nine states, and the date-gap and preview sentences     |
| `lib/api/client-requests.ts`                | The studio's endpoints, kept apart from `portal.ts` for the reason the API keeps them apart |
| Two routes under `/[orgSlug]/work/requests` | The inbox and one request                                                                   |
| `WorkListScreen`                            | The way in                                                                                  |
| `ClientRequestView.clientOrganizationName`  | An API addition this screen could not work without — see below                              |
| 21 web cases                                | Three of them unit cases over the presentation module                                       |

### The API addition, and why the screen forced it

A manager triaging a request could not find out **which client had asked**.
`GET client-organizations` is gated on `org.manage`, which only `owner` holds; `client_request.triage`
belongs to `owner`, `org_admin`, `workspace_admin` and `manager`. So three of the four roles the
matrix trusts to answer a client could not learn the client's name.

`clientOrganizationName` is now on the **internal** projection, resolved by a scoped read — one
read for a whole page rather than one per row, because a queue that issued a query per request
would be quadratic in its own length. It is not a disclosure: it is a studio reading its own
customer list, which is the same list `ClientsController` serves to an owner.

This is the third time in this session that a screen has found a hole in a projection, after
`canWithdraw`. Both were the same shape — a view built for one reader turning out to be
unusable by another — and both were fixed in the projection rather than worked around in the
screen.

### Accepting is two steps, because it is a promise

`REQ-03 Commitment review` is a separate artboard in the design, headed "You are about to promise
a date to Atlas Hospitality", and it earns the extra click: an acceptance creates work, commits a
date and tells a client, and REQ-002 makes all three one transaction.

The review shows **the sentence the client will read**, built from the same two fields the API is
about to store rather than from a template that could drift from them. And it states the gap. The
artifact is emphatic — "10 SEP ≠ THEIR DESIRED 3 SEP · THE DIFFERENCE IS STATED, NOT HIDDEN" — so
a manager promising a later date than the one asked for reads that sentence while the date can
still be changed. Nothing is written until the second button.

### Every outcome names its own price

The artifact's four actions are "Commit with a date · Ask another question · Defer with a reason ·
Decline with a reason", under the caption **"EVERY OUTCOME REQUIRES A REASON THE CLIENT CAN
READ."** Each control says what it needs in its own label, so the cost of an outcome is visible
before it is chosen.

The screen is not what enforces it. `23-ERD` §6 attaches the facts to the moves and
`clientRequestStateMachine` refuses a move that arrives without them; the labels describe a rule
that already holds. That is the right relationship between a screen and a lifecycle, and the
opposite of a form that is the only thing between a user and a bad row.

A request nobody has opened gets a fifth control, "Start triaging", because §6 routes every
answer through `triage` — a manager should not discover that by being refused.

### The schedule impact is a fact or it is absent

`WEB-005`'s own name promises "schedule impact", and the artifact draws "Impact: collides with
Content migration, which already forecasts 8 Sep". **Milestones are `MILE-001` and do not exist,
and nothing in this system models capacity**, so that line here would be invented.

What the screen shows instead is something it can check: the work already due in the same project
within three days either side of the date being promised, counted from `work_items.due_at`, with
the titles. The sentence ends by saying what it is not — "a count of dated work, not a check of
anybody's capacity — nothing in this system models that yet" — and a test asserts that sentence
is present. A count a manager can verify beats a warning they cannot.

**This is the ticket's one deliberate shortfall against its own title**, and it is recorded here
rather than papered over.

### No rail item, for the third time

`22-SCREEN-BY-SCREEN` §1 fixes the internal rail at eight destinations and Requests is not one of
them. The design artifact's breadcrumb reads "WORK · REQUESTS", which settles it: the inbox lives
under `Work` and is reached from `TM-03`. `INTERNAL_NAVIGATION` was not touched, exactly as
`CLIENT_NAVIGATION` was not on the client side, and a test asserts the rail still contains no
request link.

### Named gaps in WEB-005, carried deliberately

1. **No collision analysis**, as above. Milestones are scheduled by **no ticket** — see the correction below.
2. **No discussion thread.** The artifact draws one on the triage screen as it does on the
   client's. `CHAT-001`. The clarification question is the only thing a manager can say to a
   client, and the only thing a client can read back.
3. **No client history on the request.** `TM-12` lists it, `GET :id/history` exists and returns
   the audit trail, and **the screen does not render it**: the rows carry actor ids and no
   names, so a history panel today would be a list of UUIDs. It is a gap in the screen with the
   endpoint already behind it, which is the cheapest kind to close once a people directory
   exists.
4. **No duplicate suggestion.** `TM-12` lists it; similarity is a judgement nothing computes.
5. **No files.** `FILE-001`.
6. **No owner on the acceptance.** `TM-12` says "Acceptance requires committed scope/owner/date"
   and `REQ-002`'s body accepts `work.ownerUserId` — the screen does not offer it, because
   nothing lists the people in an organization and a picker would have one invented name in it.
   The work item is created unowned, which is what `WorkItemsRepository` does anyway.
7. **The inbox pages at 200 and says nothing when it fills.** `WorkListScreen` warns when its
   page is full; this one does not. A studio with more than 200 requests would silently see the
   oldest 200 — recorded rather than fixed, because the fix is the same cursor paging
   `WEB-002`'s second half owes the work list.

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
   inside a request handler. **Closed 2026-08-30:** the relay's lifecycle consumer runs
   exactly that rule, as system, idempotently — see the PLAT-004 section.
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
   box. That is `CHAT-001`; there is no `messages` table. The one thing the studio can say to a
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
   **Closed 2026-08-30 by migration 0012**, which converted all four columns — the three this
   note names and `client_requests.committed_at`, which the triage screen filled the same way —
   to `DATE`, carried as `'YYYY-MM-DD'` strings end to end and rendered through
   `Intl.DateTimeFormat` pinned to UTC.
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
   nothing drains. **Half closed 2026-08-30:** both events are now published and drained;
   what still notifies nobody is the absence of `NOTIF-001`, their named consumer.
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

> **Closed 2026-08-30 by migration 0012.** The midnight-UTC instant itself turned out to be
> the residual defect — a reader west of UTC saw the stored instant a day early — and the
> columns are now `DATE`, with the value carried as a `'YYYY-MM-DD'` string end to end. The
> `2026-02-31` round-trip refusal survives unchanged in `parseTargetDate`.

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
   written, so `project.created` is audited and not published. (2026-08-30: the relay now
   exists, but `24-EVENT-CATALOG` §4 names no project-created event, so this is now an
   absence in the catalog rather than in the relay.)
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
   **Closed for the primitive layer on 2026-08-30** — `pnpm test:vr` screenshots every
   Storybook story against committed baselines. The screens themselves are still
   unregressed: apps/web has no stories, and that remains open.
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
   written. (2026-08-30: the relay is written and gained `UPDATE` on `client_requests` for
   the lifecycle rule; the gap **narrows but stays open** — the relay suite still runs
   under the harness credential, and exercising `tmanage_worker` needs a
   `TMANAGE_TEST_WORKER_DATABASE_URL` path that is unscheduled.)
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
   establish is where the second half goes. **Closed 2026-08-30:** it went there — five
   producers now write both halves in one transaction, and the relay drains the second.
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
  **Closed 2026-08-30**: headless Chromium turned out to run here, and `packages/ui/vr/` now
  screenshots all 28 stories in light, dark and RTL against committed baselines.
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

| Ticket    | Scope                                              | Status        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------- | -------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PLAT-001  | pnpm monorepo, shared config, ownership boundaries | `implemented` | Workspace builds; boundary rules encoded as lint errors in `eslint.config.js`, and the `db` boundary is proven to fire                                                                                                                                                                                                                                                                                                                                                            |
| PLAT-002  | one-command local stack                            | `implemented` | `compose.yaml` (MariaDB 11.4 · Valkey 8.1 · MinIO). One defect fixed this session (the `users.sql` init-mount could never have succeeded). **Still never started** — no container runtime here; the CI `database` job is what will verify it                                                                                                                                                                                                                                      |
| PLAT-003  | CI gates, secret/dependency scans                  | `implemented` | `.github/workflows/ci.yml` + `.gitleaks.toml` + `db:grants` + the least-privilege suite. **Not `tested`: the workflow has never run.** Artifact signing deferred (nothing to sign yet); branch protection is an owner action                                                                                                                                                                                                                                                      |
| OBS-001   | OpenTelemetry correlation + log redaction          | `not_started` | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| DATA-001  | migration framework, UUIDv7, app/migration users   | `tested`      | Migrator: 15 database tests + 9 splitter tests. **Exception:** `scripts/db/users.sql` is now covered by 12 static assertions and by a CI suite that has not run; it has still never been executed against a server                                                                                                                                                                                                                                                                |
| AUTHZ-001 | tenant context + isolation foundation              | `tested`      | 44-case isolation corpus against real MySQL + 45 guard-analyser unit tests + 29 evaluator tests. Under the **admin** credential; the least-privilege re-run is pending CI                                                                                                                                                                                                                                                                                                         |
| PLAT-004  | transactional outbox + idempotency                 | `tested`      | Tables, append-only audit and per-tenant idempotency, and — since 2026-08-30 — the relay itself: five producers, the `apps/worker` dispatcher (claim/backoff/park, loop and controlled-batch modes) and the lifecycle consumer, proved by 14 database cases driving the dispatcher from `@tmanage/worker` plus 10 worker unit cases                                                                                                                                               |
| UI-001    | tokens, primitives, Storybook, visual harness      | `tested`      | 106 cases in `packages/ui`: 33 contrast, 14 token drift, 59 component/theme including axe over the whole primitive surface in light, dark, high contrast and Arabic RTL. Storybook builds and was driven through three stories. **The visual-regression harness is built (2026-08-30)**: 108 committed baselines over every story in light, dark and RTL, verified stable and proven able to go red. **The eight specified primitives landed 2026-08-30 and the ticket is whole** |

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

| Component                                         | Status        | Notes                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/config`                                 | `tested`      | 25 tests. MySQL schemes, `DEPLOYMENT_PROFILE`, `TENANT_GUARD_MODE`; production refuses dev substitutes and placeholder secrets                                                                                                                                                                                                                                                                                  |
| `packages/domain` — state machines                | `tested`      | 35 tests across all 7 lifecycles in `23-ERD` §5–§11                                                                                                                                                                                                                                                                                                                                                             |
| `packages/domain` — authorization                 | `tested`      | 29 tests over the §11 grid — application layer                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/domain` — value objects                 | `tested`      | 11 tests. UUIDv7 (incl. >2³² ms), content hash                                                                                                                                                                                                                                                                                                                                                                  |
| `apps/api` — migrator                             | `tested`      | 15 database tests, 9 splitter tests                                                                                                                                                                                                                                                                                                                                                                             |
| `apps/api` — schema (0001, 0002)                  | `tested`      | Applied from empty on every database run; invariants read back from `information_schema`                                                                                                                                                                                                                                                                                                                        |
| `apps/api` — tenant context + guard               | `tested`      | 45 analyser tests, 44 corpus tests                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/api` — least-privilege credentials          | `tested`      | 12 static assertions, plus **21 dynamic cases that now actually run** — against a long-lived MySQL 8.0.45 and again against MariaDB 11.4.5, both with the real `tmanage_app` credential. No container was involved. They still skip on the default per-file path, which has no such credential                                                                                                                  |
| `apps/api` — Drizzle schema + guarded seam        | `tested`      | 44 drift cases against `information_schema`, mutation-tested; the seam is proven to keep the guard on the query path                                                                                                                                                                                                                                                                                            |
| `apps/api` — repositories                         | `tested`      | Projects (18 cases), organizations/workspaces/memberships (21), and **client organizations, client memberships, project memberships and work items (49)**. All eight follow one shape. **PROJ-002 adds 19 HTTP cases** over project creation and the workspace list                                                                                                                                             |
| `apps/api` — membership resolver + bootstrap read | `tested`      | 24 database cases. The only waiver of ADR-0001 layer 3, bounded by an audited reason, a read-only rule and a table allowlist — all three mutation-tested                                                                                                                                                                                                                                                        |
| `apps/api` — principal assembly (TEN-002)         | `tested`      | Project relation loaded on the scoped path; a test asserts no guard event is emitted while a principal is assembled                                                                                                                                                                                                                                                                                             |
| `apps/api` — sessions (ID-001)                    | `tested`      | 43 database cases + 27 unit cases. Rotation, reuse detection, global cutoff, device list; the append-only ledger is proven immutable under the admin credential                                                                                                                                                                                                                                                 |
| `apps/api` — identity database path               | `tested`      | `identityRead` / `identityTransaction`. Zero tenant tables reachable, enforced in `observe` mode as well as `enforce`; no guard event across a whole session lifecycle                                                                                                                                                                                                                                          |
| `apps/api` — HTTP                                 | `tested`      | NestJS 11 + Fastify. The four-guard pipeline, the stable error envelope, correlation ids, session routes and the first tenant-scoped endpoints: 36 database cases in `http-pipeline.db.test.ts` plus 16 CSRF unit cases and 2 DI cases. Eight mutations confirm the guards fire                                                                                                                                 |
| `apps/api` — audit (AUD-001)                      | `tested`      | 23 database cases + 26 unit cases. Append-only proved against the **migration** credential, not only the runtime one; the metadata gate refuses content at the write boundary; a rolled-back command leaves no row; a guard denial is recorded end to end through the real application                                                                                                                          |
| `apps/api` — project-membership commands          | `tested`      | Grant, role change and revocation, each one transaction containing the write and its audit row. The revocation records the facts the `DELETE` destroys                                                                                                                                                                                                                                                          |
| `apps/api` — client projection boundary (SEC-001) | `tested`      | 16 database cases over §11's grid and 9 unit cases over the interceptor. `findForbiddenClientFields` finally has a caller: a client response carrying a forbidden field is refused as a 500, not filtered                                                                                                                                                                                                       |
| `apps/api` — client requests (REQ-001, REQ-002)   | `tested`      | 47 database cases over real HTTP, 1 skipped. One table with no delete and no update path; the facts §6 requires are written only by the transition that required them; the commitment coherence rule is a trigger, so it holds on a direct SQL session too. Two projections built separately, not one filtered. **REQ-002** makes an acceptance and its work one transaction, with one door onto `accepted`     |
| `apps/api` — conversations (CHAT-001)             | `tested`      | 45 database cases over real HTTP, 1 skipped. Three tables, twelve routes. The sequence allocator holds under ten concurrent posts; a thread is one level deep because `fk_messages_parent_is_root` refuses the second, not because the service promises it. A message is never deleted — `users.sql` grants no DELETE — and a moderation returns the row with its body gone. Two defects found by its own suite |
| `apps/worker`                                     | `not_started` | Directory exists, empty. `outbox_events` still has no producer and no relay. CHAT-001 adds two more named events nothing emits — `message.created.v1` and `message.converted.v1`                                                                                                                                                                                                                                |
| `apps/web`                                        | `tested`      | 317 unit cases across 15 files; **twenty-two routes** at `next build`. `CL-09`/`CL-10` ship with WEB-004's second half; `REQ-01`/`REQ-02`/`REQ-03` with WEB-005; `CL-02` renders two of §6's five kinds of card                                                                                                                                                                                                 |
| `packages/ui` (UI-001)                            | `tested`      | Token package drift-tested against the design export in both directions; 13 primitives; the contrast arithmetic that jsdom cannot do; Storybook with theme, contrast, density and direction as globals. Three AA defects found and fixed in the component layer                                                                                                                                                 |
| `packages/contracts`, `observability`, `test-kit` | `not_started` | Directories exist, empty                                                                                                                                                                                                                                                                                                                                                                                        |
| CI pipeline                                       | `implemented` | Three jobs written, YAML parses, guards proven to fire under `CI=1`. **Never executed** — no runner here                                                                                                                                                                                                                                                                                                        |
| Design source audit                               | `tested`      | 172/172, and now Prettier-idempotent so `audit:design` no longer turns `format:check` red                                                                                                                                                                                                                                                                                                                       |
| Seed world                                        | `tested`      | Exercised by every database run                                                                                                                                                                                                                                                                                                                                                                                 |

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

### A correction to ticket names — opened at the end of the SEC-001 session, **closed here**

The previous session re-read `28-SPRINT-TICKETS` to check one name, found that several ids this
file and this codebase used were not in it, and left three of them in the source because
correcting a screen after its chain had run would have made the recorded result describe a tree
that never existed. That was the right call and this session pays it off — and the audit found
more than three.

**The pass was mechanical, not judgemental**: every string of the shape `XXX-000` in `apps/`,
`packages/` and `scripts/` was extracted and checked against the ids `28-SPRINT-TICKETS` §§3–12
and §12A actually schedule. Seven were inventions.

| Invented id    | What it was pointing at                                                 | Replaced with                                                                                         |
| -------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `MILE-001`     | Milestones on `CL-01` and `TM-03`                                       | "milestones … — unscheduled". No row in `28-SPRINT-TICKETS` builds milestones at all                  |
| `PULSE-001`    | The latest internal pulse / client update on the same two screens       | Folded into the same "unscheduled" phrase                                                             |
| `PEOPLE-001`   | A people directory, on four screens and in two API comments             | "a people directory, unscheduled". The gap is real; the plan schedules nothing that closes it         |
| `MAIL-001`     | The mailer `ON-04` needs, on `InviteTeamScreen`                         | "a mailer — unscheduled", naming `NOTIF-001` as the nearest real ticket and saying it is not a mailer |
| `AUD-002`      | The audit read model behind `ID-05`'s security receipt                  | **`ADMIN-002`**, which is the real ticket for an audit viewer                                         |
| `DOC-001`      | Decisions and docs on `TM-13`                                           | `WORK-003` for dependencies, plus "decisions, unscheduled" for the rest                               |
| `INSIGHT-001`  | A scored health indicator, in `TM-03`'s doc comment                     | `HOME-001`, the nearest thing the plan schedules                                                      |
| `PROJ-002`     | Project creation and the workspace list, in six comments and a filename | **`PROJ-001`**, which is the ticket that work belongs to                                              |
| `CONTRACT-001` | Generating `packages/contracts` from `openapi.yaml`                     | "which no ticket in `28-SPRINT-TICKETS` schedules"                                                    |

`CONV-001` was corrected to `CHAT-001` in the previous session and is not repeated here.
`apps/api/test/proj-002-project-creation.db.test.ts` was renamed to `proj-001-…` with `git mv`,
and the one file that cited it by path was updated.

**Three false statements were found in the same pass, and they were worse than the ids.** Each
was true when written and had been overtaken by a ticket that landed afterwards:

1. `ProjectOverviewScreen` told a manager "No portal exists to read it in yet — that is
   CLIENT-001", under a list of the items a client can see. `CLIENT-002` shipped that portal a
   session earlier. Rewritten to say what the list is: what a client member reading the portal
   right now would see.
2. `FirstProjectScreen` said choosing a client was not saved because `CLIENT-001` was unbuilt.
   `CLIENT-001` shipped `project_clients` and `POST projects/:id/clients`. The gap is this
   screen's — onboarding does not call the endpoint — and it now says that instead.
3. The same screen's doc comment said the project is created "as of `PROJ-002`". Corrected with
   the id.

**One defect was found and deliberately not fixed here.** `ProjectOverviewScreen` renders
`<Badge>Internal</Badge>` unconditionally. Before `CLIENT-001` that was merely redundant,
because nothing could be linked; it is now **capable of being wrong** — a project shared with a
client organization still reads "Internal". `ProjectSummary` carries no client field, so fixing
it needs an API client function, a query and a test, which is a change to a screen rather than a
correction of a comment. It is recorded in the WEB-002 second-half list below and marked in the
source at the point of the defect, in the words above.

### The gate that stops this recurring

Nine sessions of hand-written ticket ids produced nine invented ones, and every one of them was
readable, plausible and wrong. A comment asking the next author to check would have caught none.
`apps/web/tests/ticket-ids.test.ts` does, in two cases:

- It parses the ticket ids out of `docs/planning/28-SPRINT-TICKETS-AND-ESTIMATES.md` — the
  ticket **rows**, not prose mentions — and asserts it finds exactly **76** of them. A hard-coded
  list here would be a second copy of the backlog, and a second copy is how the drift started.
- It scans every `.ts`/`.tsx` under `apps/web/src` and fails naming any id the plan does not
  schedule. Three digits, so screen ids (`CL-09`, `TM-03`, `REQ-01`) and ADR numbers are not
  matched.

**Mutation-tested rather than assumed**: `FAKE-001` was appended to `apps/web/src/lib/fixtures.ts`
and the suite failed with `apps/web\src\lib\fixtures.ts: FAKE-001`, then the probe was reverted.

It runs in the `node` environment rather than the suite's default `jsdom`, which costs several
seconds of setup per file and buys a file that reads two directories nothing at all.

**It covers `apps/web` only.** `18-REPOSITORY-STRUCTURE` puts the web app above the API and
`eslint.config.js` enforces that boundary, so a test in this package must not walk `apps/api` or
`packages/*`. Those trees were corrected by hand in the same pass and are **not** guarded.
Extending the check to them needs a repository-level gate of its own — a `pnpm audit:tickets`
beside `audit:design` — and that is now a named gap rather than a silent one.

### The progress count, re-derived rather than re-quoted

The previous section said "27½ of 74 tickets, 191 of 615 story points, about 31%" and warned
that the count had not been walked. It has now been walked, ticket by ticket, against
`28-SPRINT-TICKETS` §§3–12. **Both the numerator and the denominator were wrong.**

**The denominator.** §§3–12 schedule **70 tickets and 583 story points** — parsed out of the
document rather than counted by eye, and the same parse the new gate uses. `SEC-002` carries
"variable" instead of a number and contributes 0. The old "74 / 615" matches no reading of the
file: §12A's paid-beta gate adds a further 6 tickets and 53 points, which would give 76 and 636,
and §§3–12 alone give 70 and 583. The figure appears to have been an accumulation rather than a
count.

**The rule used, stated so the next session can apply the same one.** A ticket counts **whole**
when everything its own §-row's Scope column names is built and covered by a check that has
actually run; **half** when a named part of that scope is built and tested and another named part
is absent; **zero** otherwise. Halves are recorded against the reason, never rounded away.

| §   | Ticket     |  SP | Counted  | Why                                                                                                                                                                              |
| --- | ---------- | --: | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3   | PLAT-001   |   5 | whole 5  | Workspace, shared config and the ownership boundaries, the last enforced as lint errors and proven to fire                                                                       |
| 3   | PLAT-002   |   5 | half 2.5 | Environment validation is tested (25 cases). The compose stack has **never been started** — no runtime here                                                                      |
| 3   | PLAT-003   |   8 | half 4   | Workflow, gitleaks and the scans are written. The workflow has never run and will not; artifact signing is deferred                                                              |
| 3   | OBS-001    |   5 | 0        | Not started                                                                                                                                                                      |
| 3   | DATA-001   |   5 | whole 5  | Migrator, UUIDv7, the two database roles                                                                                                                                         |
| 3   | AUTHZ-001  |   8 | whole 8  | Tenant context, scoped repository, composite constraints, the corpus                                                                                                             |
| 3   | PLAT-004   |   8 | whole 8  | Tables, audit, idempotency **and the relay**: producers, dispatcher (backoff, parking, both run modes) and the lifecycle consumer, proved against the server                     |
| 3   | UI-001     |   8 | whole    | Token package, **21 primitives — the eight specified ones landed 2026-08-30**, Storybook, the visual-regression harness at 108 baselines, and an adversarially-reviewed combobox |
| 4   | ID-001     |   8 | whole 8  | Session cookie, rotation, reuse detection, CSRF, driven through real HTTP                                                                                                        |
| 4   | ID-002     |   8 | half 4   | Argon2id, TOTP, recovery codes, 213 cases. **Passkeys are in the row's own scope** and are not built; nor are SSO or password recovery                                           |
| 4   | TEN-001    |   8 | whole 8  | Organization, workspace, membership, provisioning, the directory                                                                                                                 |
| 4   | TEN-002    |   8 | whole 8  | Roles, capabilities, the evaluator, and the principal assembly that wires it                                                                                                     |
| 4   | TEN-003    |   5 | whole 5  | Issue, accept, revoke, expiry; a hashed single-use token                                                                                                                         |
| 4   | AUD-001    |   5 | whole 5  | The service, the view model, the first producer                                                                                                                                  |
| 4   | WEB-001    |   8 | whole 8  | Nine screens, four shells, all wired. The `BackendPending` notices on five of them point at **other tickets'** servers, not at unwritten WEB-001 work                            |
| 4   | TEST-001   |   8 | whole 8  | The seed, the tenant corpus, and — since 2026-08-30 — the generated role grid: every cell derived from the ceiling, every refusal a counted security event                       |
| 5   | PROJ-001   |   8 | whole 8  | Schema, service, repositories, creation, the workspace list, the client link                                                                                                     |
| 5   | WORK-001   |   8 | whole 8  | The aggregate and the state machine, asked rather than restated                                                                                                                  |
| 5   | WORK-002   |   8 | whole 8  | List, read, create, update, version token — and the cursor, evidenced by three keyset cases on 2026-08-30                                                                        |
| 5   | WORK-003   |   8 | whole 8  | The blocker ledger (one active per item, engine-enforced), immutable acyclic edges with audited removal, and the explainable computed health signal                              |
| 5   | WEB-002    |  13 | half 6.5 | `TM-03`, `TM-10`, `TM-13`, plus paging, sorting, selection and the previewed bulk audience change. Saved views alone are absent — no server home is scheduled                    |
| 5   | TEST-002   |   8 | whole 8  | Unit, integration, auth — and the deterministic performance fixture over a real `packages/test-kit`, plans and volume, never a stopwatch                                         |
| 6   | CHAT-001   |   8 | whole 8  | Conversations, memberships, messages, the thread model and the sequence allocator, proved under concurrency                                                                      |
| 6   | CHAT-002   |   8 | whole 8  | The allowlist as a closed grammar, the write-boundary sanitiser, the derived plain body, and the engine-authored edit history                                                    |
| 6   | CHAT-003   |   8 | whole 8  | The conversion whose idempotency is the link table's own unique key, proved under a real race                                                                                    |
| 6   | WEB-003    |  13 | whole 13 | `TM-06`, `TM-08`, `TM-09`, plus the rich composer (notation to CHAT-002's grammar, never HTML) and sequence-cursor paging. The scope row names nothing else                      |
| 6   | NOTIF-001  |   8 | half 4   | The record and its consumers, permission-checked at delivery, idempotent by the dedupe key. **Preferences are absent** — the contract draws no table for them                    |
| 6   | RT-001     |  13 | whole 13 | Tickets, current-row subscriptions, cursor served and gaps healed by refetch — both ends of the wire. Presence is not in the row and stays named on the screen                   |
| 6   | TEST-003   |   8 | half 4   | E2E-02 and AUTH-04 run through a real Chromium against the real stack, outside the chain. REL-01/02 need a load balancer this plan does not have                                 |
| 7   | CLIENT-001 |   8 | whole 8  | Thirteen routes, the client-admin boundary proved from both sides                                                                                                                |
| 7   | CLIENT-002 |   8 | whole 8  | The portal, its own path, the field-by-field projection                                                                                                                          |
| 7   | REQ-001    |   8 | whole 8  | The aggregate, the API, the two projections                                                                                                                                      |
| 7   | REQ-002    |   8 | whole 8  | Triage, clarify, and an acceptance that is one transaction with its work                                                                                                         |
| 7   | WEB-004    |  13 | whole 13 | `CL-01`, `CL-02`, `CL-09`, `CL-10`                                                                                                                                               |
| 7   | WEB-005    |   8 | whole 8  | `REQ-01`, `REQ-02`, `REQ-03`                                                                                                                                                     |
| 7   | SEC-001    |   8 | whole 8  | The interceptor with a caller, and §11's grid over operations                                                                                                                    |

Every other ticket in §§3–12 — two of Sprint 3's seven (RT-001, TEST-003), and all of
Sprints 5 through 9 — is zero. **CHAT-001 was added to this table on 2026-08-26** as Sprint
3's first entry, **CHAT-002 on 2026-08-29** as its second, **CHAT-003 on 2026-08-30** as its
third, and **WEB-003's first half the same day** as its fourth. **On 2026-08-30 the rows of
PLAT-004 and WEB-003 moved from half to whole, NOTIF-001 joined at half, and WORK-003 moved
from zero to whole** — the relay session's four tickets.

| Sprint                                                                                          | Tickets       | Points         |
| ----------------------------------------------------------------------------------------------- | ------------- | -------------- |
| Sprint 0 (§3)                                                                                   | 5½ of 8       | 36.5 of 52     |
| Sprint 1 (§4)                                                                                   | 7½ of 8       | 54 of 58       |
| Sprint 2 (§5)                                                                                   | 5½ of 6       | 46.5 of 53     |
| Sprint 3 (§6)                                                                                   | 6 of 7        | 58 of 66       |
| Sprint 4 (§7)                                                                                   | **7 of 7**    | **61 of 61**   |
| Sprints 5–9                                                                                     | 0 of 34       | 0 of 293       |
| **§§3–12**                                                                                      | **31½ of 70** | **256 of 583** |
| **As re-derived, before CHAT-001: 22½ of 70 tickets and 174 of 583 story points — 29.8%.** That |
| was lower than the 31% this file used to quote, against a denominator that is smaller as well:  |
| the old figure was optimistic in the numerator and inflated in the denominator, and the two     |
| errors partly hid each other.                                                                   |

**With CHAT-001, which landed the same day: 23½ of 70 tickets and 182 of 583 — 31.2%**,
**with CHAT-002 on 2026-08-29: 24½ of 70 and 190 of 583 — 32.6%**, **with CHAT-003 verified
on 2026-08-30: 25½ of 70 and 198 of 583 — 34.0%**, **with WEB-003's first half the same
day: 26 of 70 and 204.5 of 583 — 35.1%**, **with PLAT-004 made whole later that day:
26½ of 70 and 208.5 of 583 — 35.8%**, **with WEB-003's second half the same session:
27 of 70 and 215 of 583 — 36.9%**, **with NOTIF-001's first half after it: 27½ of 70
and 219 of 583 — 37.6%**, and **with WORK-003 whole to close the session's fourth chain:
28½ of 70 and 227 of 583 — 38.9%.** The Progress section below carries the latest. CHAT-001 counts whole because everything §6's row
names — conversations, messages and the thread sequence model — is built and covered by a suite
that ran.

**Screen tickets: 4½ of 11.** WEB-001, WEB-003, WEB-004 and WEB-005 whole, WEB-002 half;
WEB-006 through WEB-011 are untouched. An earlier "4½ of 11" here counted screens rather than
tickets; this one is tickets, and matches by coincidence.

**Sprint 4 is complete, and that survives the re-derivation** — all seven of §7's tickets, 61 of
61 points. It is still the first sprint in this plan that is.

### The next coding task

**E2E growth landed on 2026-08-31 — the first of the three choices the previous revision of this
section listed — and this section is replaced rather than amended.** It cost two UI fixes it did
not plan for, which is the argument for the next one being another journey rather than another
feature.

**The next one is a choice among three, in the doc's standing order:**

1. **A second mail producer — scouted on 2026-08-31, and it is not the small slice this
   section used to call it.** A six-agent read-only fleet mapped it end to end before any code
   was written; what it found is recorded in "What the mail fan-out scout found" below, because
   two of the findings change the shape of the ticket rather than merely inform it. The short
   version: the plumbing is easier than expected and the _policy_ is harder. Sending is a
   decision about `35-NOTIFICATION` §1 and §7 before it is a decision about code.
2. **More journeys.** `E2E-03`, `E2E-04` and the remaining `AUTH-*` lines are cheap now that the
   boot cost is paid and the harness has been green across four sessions. On this session's
   evidence a journey is also the most productive defect-finder in the repository: two screens
   in sequence is a thing no unit suite tests.
3. **The MariaDB run for 0012.** The engine-skew check has not seen the DATE migration. The
   local `mariadb-11.4.5` zip is GONE from disk; re-downloading (~90 MB from
   archive.mariadb.org) needs Peter's explicit OK first.

### What the mail fan-out scout found

Read-only, six agents, no file edited. Recorded because it cost real effort and because three of
its answers are load-bearing for whoever writes the slice.

**The plumbing is already there, and in two places it is better than expected.**

- **The worker can read email addresses today, with no grant change.** `scripts/db/users.sql`
  grants `SELECT ON tmanage.*` to `tmanage_worker`, deliberately and with a reason written in the
  file's own header, and `users-sql.test.ts` pins that the database-wide grant is `SELECT` and
  nothing else. `users.email` is `VARCHAR(254) NOT NULL` with a case-insensitive unique key, and
  `users.locale` and `users.timezone` sit on the same row.
- **The worker already validates the whole email config.** `apps/worker/src/main.ts` calls
  `loadEnv()`, which parses the entire monorepo schema — `EMAIL_DRIVER`, `EMAIL_FROM_ADDRESS`,
  `EMAIL_FROM_NAME` and every `SMTP_*` key, including the `superRefine` rules. A worker-side
  mailer needs **no new environment variable and no config change**.
- **The mailer code is nearly free to share.** `mailer.ts` is types with zero imports;
  `console-mailer.ts` imports only its own port; `smtp-mailer.ts` imports only `nodemailer`.
  The Nest coupling is confined to `mailer.module.ts`, and the invitation-specific code to
  `invitation-email.ts` and `invitation-mailer.ts`. Moving the port and the two drivers into a
  workspace package leaves the API's producer where it is. `apps/worker` depends on
  `@tmanage/config` and `@tmanage/domain` today and imports nothing from `apps/api`.

**Two things make it a real ticket rather than a small one.**

1. **A handler cannot send mail where handlers currently run.** `OutboxHandler` is
   `(event, tx) => Promise<void>` and the dispatcher runs it **inside the batch's open
   transaction**, with a savepoint per event. An SMTP round trip there would hold a database
   transaction open across a network call to a third party — the exact thing the invitation
   producer avoids by sending _after_ its transaction commits. So the slice needs a place to
   send from that is outside the transaction, and `WORKER_OUTBOX_HANDLERS` is a static `const`
   with no room to inject a mailer. Both are structural changes to the worker, not additions.
2. **`35-NOTIFICATION` §1 asks for two things this product cannot supply.** The rule is:
   "Every email includes organization, action, deadline/timezone, why recipient, safe CTA,
   **preference/support route**", and separately "use project/deliverable title only **when
   tenant policy permits**". There is no preference centre — `contracts/tmanage-core.dbml` draws
   no preferences table, which is why `NOTIF-001` stands at half — and there is no tenant policy
   column to consult about titles. §7 scopes unsubscribe to _non-transactional_ mail, and §2
   files informational notifications under "bundle/digest by default", which is precisely the
   category unsubscribe exists for. The invitation dodged this honestly: an invitation is
   transactional, and its body names the inviter instead of pretending a preference centre
   exists. A general notification fan-out cannot make the same claim.

**The asymmetry worth stating plainly.** A notification row is safe after revocation _because_ it
carries no content — `type`, `object_type`, `object_id` and nothing else — and the reader
re-resolves the object through the authorized read path, where a revoked object answers 404.
**An email has no display time.** Whatever it says is delivered permanently at send. The planning
pack states the content-free property for the _row_ only; it does not answer the question for the
email, so that answer has to be made deliberately rather than assumed.

**The narrowest defensible first cut, if the slice is taken.** Mail only the person who submitted
a client request, only about their own request, using the three `§3` client-request templates
(received / clarification required / accepted). That recipient is already resolved by
`client_request.transitioned.v1`'s existing consumer, already gated by the three-part
current-permission check, and every fact those templates need is either the client's own words
(the request title they typed) or something already published _to_ them by contract (the
clarification question, the client-safe scope summary). It is transactional in the same sense the
invitation is, so §7's unsubscribe requirement is satisfied the same way. The internal manager
fan-out is the part that needs preferences, and it should wait for them.

Two placeholders in those templates have no value in the product: `{{questionCount}}` (the schema
holds one clarification question, not a list) and `{{timezone}}` (committed dates are `DATE`
columns since 0012 and carry no zone). Whatever the slice does about them belongs in the record,
the way the invitation's `{{scope}}` and `{{project}}` divergences already are.

**A gap `CHAT-001` did not close, said plainly because its own motivation implies otherwise.**
The client request loop still cannot hold a conversation _with a client_. `CHAT-001` built the
room the studio talks in, and no client role holds any conversation capability — so
`ClientRequestDetailScreen` still tells a client to reply however they normally reach the studio,
and that sentence is still honest. Closing it needs an audience on a conversation, a projection
behind it, and an evaluator relation for a client principal reading one. None of the three is
scheduled by `28-SPRINT-TICKETS`, so it is a gap rather than a ticket.

A note on a gap this file used to give a number to: **there is no people-directory ticket.**
`28-SPRINT-TICKETS` does not schedule one, and earlier entries here wrote `PEOPLE-001` anyway to
have something to point at. The gap is real and has cost four screens something specific — the
request inbox cannot name who submitted, the triage screen cannot render a history that is only
actor ids, no acceptance can name an owner, and every work item's owner reads "Assigned". As of
2026-08-26 the invented id is gone from the source and each of those screens says "a people
directory, unscheduled" instead, which is both shorter and true.

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
22. ~~REQ-002~~ — An acceptance and its work as one transaction: a refused
    acceptance now leaves no task in the plan describing work nobody agreed to, `accepted` has
    exactly one door, and the request's history is a read of the append-only audit trail rather
    than a second, mutable copy of it. 12 database cases, no migration.
23. ~~WEB-005~~ — `REQ-01`, `REQ-02` and `REQ-03`: the inbox a manager
    opens to see what is waiting, the four outcomes each naming the reason they need, and a
    commitment review that shows the sentence the client will read and states the gap between
    the promised date and the one asked for. 21 web cases. The screen found a second hole in a
    projection — a manager could not learn which client had asked — and it was fixed in the
    projection. Its own title's "schedule impact" is the ticket's one deliberate shortfall.
24. ~~SEC-001~~ — **done this session.** `findForbiddenClientFields` had lived in
    `packages/domain` with **no caller**; it now has one, as a global interceptor that refuses a
    client response carrying a forbidden field rather than filtering it. And §11's grid — which
    is over _operations_ — is written for the first time against the surfaces a client can
    actually reach. 16 database cases and 9 unit cases. The grid found nothing, which is the
    expected outcome on the day a corpus is written.

25. ~~CHAT-001~~ — **done this session.** Conversations, messages and the thread sequence
    model: a channel on a project, a sequence number allocated under the channel's own row lock
    and proved correct with ten posts fired at once, and a thread that is one level deep because
    InnoDB refuses the second rather than because the service promises it. 45 database cases and
    1 skip. Two defects found by its own suite — every duplicate arrived as a 500 because
    Drizzle wraps driver errors, and every moderation arrived as a 500 because the audit
    metadata gate refuses any key containing the word `message`.
26. ~~CHAT-002~~ — **done this session.** The rich-text allowlist as a closed grammar,
    sanitised at the write boundary by refusal; the plain body derived, never accepted; the
    edit history the
    engine writes so the application cannot not-write it. 29 unit and 23 database cases, plus
    four least-privilege cases. Its own chain run caught the one thing it forgot — the tenant
    guard had never heard of `message_revisions` — and the drift gate turned that from a
    shipped hole into a failing test.
27. ~~CHAT-003~~ — **written last session, verified this one.** A message converts to a work
    item exactly once, and "exactly once" is the link table's own unique key rather than a
    promise: the race's loser gets 200 with the winner's conversion and its whole transaction
    rolled back, proved by firing the race for real. The link is INSERT-only to the runtime
    credential and un-updatable by trigger. 14 database cases and two least-privilege cases;
    the full chain ran green first try this session, 705 database cases in all.
28. ~~WEB-003 first half~~ — **done this session.** The channel a person can read: TM-06's
    transcript with the composer whose retry cannot double-post, TM-08's thread pane reading
    replies as a query rather than a browser-side filter, and TM-09's convert dialog that
    defaults safe, warns before widening, and shows the existing conversion instead of
    pretending a duplicate succeeded. 9 web cases; the second half is named, not implied.
29. ~~WEB-002 second half~~ — **done this session, and the count did not move.** Cursor
    paging on both lists, sorting that never silently means "some of it", selection feeding
    one bulk action whose widening lists its consequences by title before sending and whose
    409s are reported and never retried, and a project badge that tells the truth or nothing.
    Saved views alone remain, unschedulable without a server home, so WEB-002 stays half by
    the rule. 8 web cases.

30. ~~PLAT-004 second half~~ — **done this session, and the ticket is whole.** The outbox
    writer joining five producers' transactions, the event vocabulary in the domain with
    payload shapes bound to their types, and `apps/worker`: a dispatcher that claims with
    `FOR UPDATE SKIP LOCKED`, backs off exponentially, parks at the cap and reports the
    parked, runnable as a loop **and** as one controlled batch; plus the lifecycle rule —
    work starting moves the accepted request to `planned`, work done moves it to `delivered`,
    as system, idempotent under redelivery, announced with the relay's own event. 14 database
    cases and 10 worker unit cases; the chain green first try. One fixture defect found and
    kept: the harness's admin pool writes local-time `now(3)`, three hours in a UTC relay's
    future.

31. ~~WEB-003 second half~~ — **done this session, and the ticket is whole.** The rich
    composer: a toolbar over a notation converted to CHAT-002's closed grammar before
    sending, previewed through the transcript's own renderer, checked by the domain's own
    sanitiser before the network, never HTML anywhere; unmatched notation stays literal and
    an unformatted draft stays plain. Transcript paging on the sequence-number cursor, for
    the channel and a thread's replies alike. 18 web cases, among them the property that
    every document the notation can emit is admissible to `sanitizeRichText`.

32. ~~NOTIF-001 first half~~ — **done this session, counted half by the rule.** The
    notifications table exactly as the contract drew it — a reference envelope whose one
    mutable fact is `read_at`, forward only — and two relay consumers: a submission
    notifies the triage-capable people who can reach the project, a transition notifies
    the person who asked (never their own withdrawal), both recipient sets resolved from
    current membership rows at delivery per the catalog's §6, both idempotent by the
    dedupe key that is also the future bundler's seam. Preferences have no table in the
    contract, so the half stays half. 6 database cases, 3 worker unit cases; the chain's
    first attempt failed on the schema drift map missing the new table — the gate working
    — and the second ran green.

33. ~~WORK-003~~ — **done this session, whole.** The blocker ledger: US-B04's facts
    persisted at last — raised with reason, ask, optional validated owner and since;
    resolved exactly once with outcome, when and by whom; one active entry per item
    enforced by the engine through a generated column's unique key. Immutable acyclic
    dependency edges whose removal is audited, a computed health signal whose every
    answer names its cause, `work_item.blocked.v1` in the catalog with the ask's owner
    notified once through the relay. 12 database cases. The tenant guard refused the
    first draft's recursive CTE — deliberately conservative analysis doing its job on its
    own author — and the cycle walk became level-by-level scoped SELECTs.

34. ~~WORK-002 re-derived~~ — **done this session, whole, and no production code moved.**
    The `after` cursor had shipped with WORK-001 and been driven daily by WEB-002's
    paging; the count's own rule — built **and covered by a check that has run** — is what
    kept the row at half, because no case had ever exercised it. Three keyset cases at the
    API close the gap: the walk without overlap or omission, composition with filters,
    and a cross-tenant cursor value that reaches nothing.

35. ~~TEST-001 second half~~ — **done this session, whole.** §11's role grid as a
    generated harness: seven internal roles seeded as real memberships, four
    capability-gated route families over real HTTP, every cell's verdict derived from
    `hasCapability`, every refusal required to leave exactly one counted
    `security.capability_denied` row, and the client seam pinned by one case. 9 database
    cases. The first run's own finding — a portal row whose "allowed" half is answered by
    the object layer, not the guard — stands as a comment where the row would be.

36. ~~TEST-002 second half~~ — **done this session, whole.** `packages/test-kit` exists,
    holding what the structure doc permits it — synthetic data only — and the performance
    fixture asserts what cannot flake: index-walk plans at two thousand rows (never a
    table scan; which index is the engine's, whether it scans is not) and correctness at
    volume — the exact 200 cap, a complete duplicate-free cursor walk, the twin's five
    hundred rows as invisible as its three. No stopwatch anywhere, by the standing rule.
    5 database cases, 2 test-kit unit cases.

37. ~~RT-001 first half~~ — **done this session, counted half of a 13→split.** The
    stateless sixty-second ticket the API mints over a proved session (a client principal
    refused the mint itself), the socket server in the worker refusing bad handshakes
    with 4401 and answering every subscribe from current rows with the channel's cursor,
    and the relay fan-out whose frames are ids and a sequence — "Confidential" posted,
    asserted never to cross the wire. Off by default (`REALTIME_PORT=0`) on hosts that
    cannot keep the process. 6 database cases over a real `ws` client, 6 unit. The relay
    suite's payload pin caught the additive `sequenceNo` — one chain rerun, the pin now
    asserts the new shape.

38. ~~RT-001 second half~~ — **done this session, and the ticket is whole.** The browser
    client: the mint serves the socket URL (null degrades honestly to reload),
    `useChannelLiveFeed` owns mint-connect-subscribe-reconnect with exponential backoff
    and full jitter, every frame and every subscription answers with a refetch through
    the ordinary read path, and frame content is never rendered. The channel header says
    Live. 3 screen cases over an injectable socket seam. The scope row's three words —
    tickets, authorized subscriptions, cursor/gap — all hold on both ends of the wire.

39. ~~TEST-003 first half~~ — **done this session, half by an honest ceiling.** The probe
    (headless Chromium launches here) and then the harness it unlocked: `e2e/` boots the
    whole stack — embedded MySQL, real migrations, the shared seed, API, web — under
    Playwright's global setup, outside the chain by design. E2E-02 and AUTH-04 run green
    through a real browser in 36 seconds; REL-01/02 need a load balancer and cap the
    ticket at half. The harness found three real things during bring-up, including a
    denial screen offering a composer that could never work — fixed, and asserted absent
    by the journey itself.
40. ~~The DATE migration~~ — **done this session, unscheduled.** Four calendar-date
    columns become `DATE`, the value becomes a `'YYYY-MM-DD'` string end to end, and a
    reader west of UTC stops seeing every date a day early. One driver defect found
    beneath the migration (`dateStrings: ['DATE']`), truncation proven on the live
    engine, WEB-004 gap 6 and the PROJ-002 date note closed by reference.
41. ~~UI-001's visual-regression harness~~ — **done this session; the ticket stays half
    because the eight primitives are the larger remainder.** 84 committed baselines over
    every story in light, dark and RTL — the first time RTL was ever rendered here —
    stable across three runs and proven able to go red by a broken lime token that
    reddened exactly the shots that paint lime.

42. ~~Checkbox, Radio and Switch~~ — **done this session, the first three of UI-001's
    eight remaining primitives.** Native inputs under `appearance: none`, checked states
    in ink because law 2 forbids lime to mean selection, the radio group a
    `role="radiogroup"` fieldset that owns the error, the switch's thumb travelling in
    logical coordinates. 21 unit cases, nine VR baselines committed with the components.

43. ~~Select, Tooltip and Toast~~ — **done this session, the second slice; six of the
    eight primitives now exist.** A native select under Field's contract, a tooltip built
    to WCAG 1.4.13's three demands with its describedby permanent, and the toast
    live-region decision made: announcements belong to a `role="status"` region the shell
    mounts empty before the first toast, polite because a toast is peripheral by
    definition, with no timer in the primitive. 16 unit cases, nine VR baselines.

44. ~~Combobox, DateField, TimeField — and UI-001 whole~~ — **done this session.** The
    ARIA combobox with focus that never leaves the input, the date field whose value IS
    the `'YYYY-MM-DD'` string, the time field its wall-clock twin. On the way: the
    harness exposed every dark theme's invisible error text (`--tm-on-tone` bound at
    `:root`), and a four-lens adversarial review fleet confirmed four real defects —
    value-prop desync, blur desync, hover-only Escape, Enter submitting mid-filter —
    all fixed and pinned, plus five credible reports fixed in the same slice.

45. ~~The mailer~~ — **done this session, unscheduled.** An SMTP transport behind a
    `Mailer` port, the invitation as its first producer, the printed link kept as the
    floor. A pre-chain review workflow confirmed seven findings — STARTTLS downgrade,
    the unmailed portal path, a post-commit 500, the console driver's false error rows,
    and three coverage holes — all fixed and pinned, AUTH proven on a real socket.

46. ~~Five more browser journeys, and the deadlock they found~~ — **done this session.**
    `E2E-01a`, `E2E-01b`, `AUTH-06`, `E2E-09` and `AUTH-01`, taking `pnpm test:e2e` from 2
    journeys to 7. Two real defects fell out of walking them: the triage screen offered three
    outcomes the state machine refuses from `needs_clarification`, so a manager who asked a
    client a question could never answer the request; and the portal told a client the studio
    "has not started on it" directly under the studio's own question. Both fixed and pinned.
    The browser's locale is now pinned in the harness, because the product's is deliberately
    not.

### Progress

**32 of 70 tickets. 260 of 583 story points — 44.6%, across Sprints 0–9.** UI-001 closed whole on 2026-08-30, the only row that moved since the re-derivation below was written. Derived ticket by
ticket against `28-SPRINT-TICKETS` §§3–12, with the rule and the per-ticket reasons written out
in "The progress count, re-derived rather than re-quoted" above. That re-derivation replaced the
"27½ of 74 tickets, 191 of 615, about 31%" this section used to carry, which was wrong in the
numerator **and** in the denominator; the percentage reads higher today only because eight
tickets moved in one session — PLAT-004, WEB-003, WORK-003, WORK-002, TEST-001 and TEST-002 to
whole, RT-001 to whole across two chains, NOTIF-001 and TEST-003 to half — each behind green chains. Screen tickets: **4½ of 11** —
WEB-001, WEB-003, WEB-004 and WEB-005 whole, WEB-002 half (its saved views remain homeless).
**Sprint 3 has four whole tickets — CHAT-001, CHAT-002, CHAT-003, WEB-003 — plus RT-001 whole and the halves of
NOTIF-001 and TEST-003, standing at 6 of 7. Sprint 2 stands at 5½ of 6, one homeless-saved-views
half from complete; Sprint 1 at 7½ of 8; Sprint 0 at 5½ of 8.**

**Sprint 4 is complete**, all seven tickets, 61 of 61 points — and that survives the
re-derivation. It is the first sprint in this plan that is.

**The client request loop is closed end to end, on both sides and in a browser.** A client asks
for something, is told plainly that their date is a wish, and can withdraw it while it is still
theirs to withdraw. A manager sees it in an inbox, asks a question, defers or declines with a
reason the client reads, or commits a date — and sees the sentence the client will read, and the
gap between that date and the one they were asked for, before promising anything. The acceptance
and the work it commits are one transaction.

That is the first loop in this product that is complete at both ends.

**Both loops are closed in the browser.** A person signs in, creates an organization, creates a
project, puts work in it, moves that work through its lifecycle, sets up a client organization,
shares the project with it, invites a colleague, and the colleague follows the link and lands
inside. Publish an item to the client and a client member can open the portal and read exactly
that item, with none of the internal record around it.

That is an end-to-end product for the first time. Three things stand between it and something a
team could use for a week:

1. **Whether the invitation is emailed depends on the deployment.** The mailer landed on
   2026-08-30, so an SMTP-configured deployment sends it. Under the `bootstrap` profile's
   `EMAIL_DRIVER=console` nothing does, the link is printed on screen for a person to send by
   hand, and `ON-04` says so in as many words — which `E2E-09` now asserts end to end.
2. **The client request loop is closed at both ends** — the first loop in this product that is.
   A client asks for something in a browser and is told plainly that their date is a wish. A
   manager sees it in an inbox, asks a question, defers or declines with a reason the client
   reads, or commits a date — seeing the sentence the client will read, and the gap between that
   date and the one they were asked for, before promising anything.

   What it still cannot do is **hold a conversation**. The studio can ask one question and the
   client cannot answer it in the portal; they are told to reply however they normally reach the
   studio. That is `CHAT-001`, and it is the largest thing standing between this loop and a team
   using it for a week.

3. **Approving, requesting changes and uploading are still in the position requests were in.**
   `approval.decide` and `file.upload` are in client ceilings with nothing behind them.
   `DEL-001`, `APPR-001` and `FILE-001` are those aggregates, and none has started.
