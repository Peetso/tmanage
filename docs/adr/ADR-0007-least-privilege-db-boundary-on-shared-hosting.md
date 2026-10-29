# ADR-0007 — The least-privilege database boundary is degraded on shared hosting; we compensate and gate the beta exit on it

- **Status:** Accepted (default under Peter's delegation of open decisions, 2026-09-05)
- **Date:** 2026-10-29
- **Deciders:** Implementation lead; Peter accepts (decision only) and owns the VPS/Cloud move at
  beta exit
- **Governing sources:** `56-SECURITY-AND-TRUST-PLAN.md` 56-27 (written there as "ADR-0002";
  that number was already taken by `ADR-0002-local-development-substitutes.md`, so this record is
  ADR-0007) and its §12 field completions; `25` §5 (separate migration/runtime users, DML-only
  grants, INSERT-only `audit_events`); `51` §6.4 (the shortfall handed to 56); `50` §8 (upgrade
  gate); `26` T-22; ADR-0001 layer 2
- **Evidence:** `scripts/db/users.sql`; `docs/runbooks/hostinger-shared-hosting.md` (pre-flight
  item 2: hPanel grants every user full privileges);
  `apps/api/src/common/observability/schema-drift.ts`; `apps/api/src/common/observability/deep-health.ts`

## Context

ADR-0001 layer 2 says the database itself stops the application from doing what it should never
do: the runtime user holds DML on the tables it needs, `audit_events` is INSERT-only, and only the
migration user may run DDL. `scripts/db/users.sql` implements that and the `pnpm test:db`
least-privilege proof passes on MySQL 8.

On Hostinger shared hosting it cannot be applied. `users.sql` needs server-global `CREATE USER` and
`GRANT OPTION`; hPanel creates users but grants each one **full** privileges on the database. On
live the runtime user can therefore `ALTER`, `DROP` and delete audit rows. The boot does not see
this: the env schema compares user names, not grants.

## Decision

1. **Accept the degraded boundary during the free beta only**, with the compensating controls
   below. It is recorded here and stated honestly to customers; it is never reported as satisfied.
2. **"Least-privilege DB users proven on the live host" is a hard line in the beta-exit gate**
   (57-01 checklist, line B-3). The first paid tier funds a Hostinger VPS/Cloud MariaDB where
   `users.sql` applies (about $5–15/month), or Hostinger ships per-user grants — whichever comes
   first. Until then the beta does not exit.

## Compensating controls

| #   | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Where it lives                      | State (2026-10-29)          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------- |
| 1   | Audit tamper evidence: hash chain plus an off-database daily root, so a privileged edit of `audit_events` is detected                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 56-11                               | Separate item               |
| 2a  | The application never issues DDL at runtime: a lint rule allows `ALTER`/`DROP`/`CREATE` only in migration files                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `eslint.config.js`                  | Open (follow-up, see below) |
| 2b  | **Schema-drift boot check.** At boot, and again whenever the reading is over 60 s old, the API compares the migration ledger with the migration files shipped in the build (every row `applied`, every file recorded, every checksum equal) and every table the code declares (`TABLES`) with `information_schema.tables`. The result is logged with both fingerprints and reported as `checks.schema` in `GET /healthz/deep` (503 on drift). In `enforce` mode (default in production) every other API route answers 503 while the schema has drifted; boot itself is never blocked. | `schema-drift.ts`, `deep-health.ts` | Built                       |
| 3   | The migration URL and the runtime URL use **different passwords** even though their grants are equal, and the migration password is not left in the running app's env after a deploy                                                                                                                                                                                                                                                                                                                                                                                                  | Runbook step                        | Operator step               |
| 4   | The `pnpm test:db` least-privilege proof keeps running on local MySQL 8 so `users.sql` never rots (MariaDB proof still open)                                                                                                                                                                                                                                                                                                                                                                                                                                                          | test chain                          | Running                     |
| 5   | phpMyAdmin SSO access is platform-admin only; every emergency repair is logged in `platform_incidents` with the operator's identity and never with customer content                                                                                                                                                                                                                                                                                                                                                                                                                   | 56-13, 56-21                        | Separate items              |
| 6   | The trust centre says it plainly: "On the current host the database user is not least-privilege; we compensate with tamper-evident audit and schema drift checks; this changes at the first paid tier." (AR heading: «حدود قاعدة البيانات»)                                                                                                                                                                                                                                                                                                                                           | 56-20 trust centre                  | Separate item               |

### What the drift check treats as drift

- a ledger row that is `running` or `failed`;
- a migration file in the build that the ledger does not record;
- a recorded checksum that differs from the shipped file (CRLF normalised, as the migrator does);
- a table the code declares that the database does not have.

Not drift (reported in the log only): ledger rows with no shipped file (a rollback deploy onto a
newer, additive schema) and tables the code does not declare. A probe that cannot be read
(database down, no migration files in the bundle) gives `not_configured` — the database check
already reports an outage, and an unreadable probe never on its own refuses service.

The fingerprint is sha256 over the sorted `version:checksum` pairs. The plan also names an
additive `fingerprint CHAR(64)` ledger column; it is not needed for the comparison (the
fingerprint is computed from the ledger rows) and is deferred to a later migration if the
Platform → Health page wants a stored value.

### Modes

`DeepHealthConfig.schemaDriftMode`: `enforce` refuses service on drift, `report` only logs and
reports. When unset: `enforce` in production, `report` in development and tests. A
`SCHEMA_DRIFT_MODE` env switch (kill switch for a false positive on live) is proposed for the env
schema.

## On drift

1. Read the `[schema-drift]` log line: it names the expected and found fingerprints and each
   problem (version, checksum prefix or table).
2. `pnpm db:status` against the live database shows the same per-version state.
3. A migration left `running`/`failed`: follow the live migration wedge repair (runbook; Peter
   pre-approved repairs of this kind on 2026-10-26). Log the repair in `platform_incidents`.
4. A checksum mismatch: an applied migration file was edited. Restore the file from git; never
   edit the ledger to match.
5. A missing table: the deploy's migrations did not land or someone dropped it. Do not hand-create
   it; re-run the migrator, then restore from backup if data was lost.
6. Only if the check itself is wrong, set the mode to `report`, deploy, and open a fix.

## Consequences

- On live, a stray DDL or hand edit is detected within a minute and the API stops serving rather
  than running on a schema it was not written for.
- The boundary is still weaker than designed: the runtime user can do damage the check only
  detects. Detection plus the audit chain is the beta posture; prevention returns at the paid tier.
- Follow-ups: the DDL lint rule (2a), the `SCHEMA_DRIFT_MODE` env switch, the trust-centre line
  (56-20), the B-3 line in 57-01's checklist, and the Platform → Health "Schema drift" tile (Figma
  first).
