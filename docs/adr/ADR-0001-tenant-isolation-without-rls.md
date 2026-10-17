# ADR-0001 — Tenant isolation on MariaDB, where row-level security does not exist

- **Status:** Accepted
- **Date:** 2026-08-16
- **Deciders:** Implementation lead (staff engineer / security lead role)
- **Governing sources:** `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §5–§6, §11;
  `03-TECHNICAL-ARCHITECTURE.md` §6; `04-SECURITY-PRIVACY.md` §4;
  `50-BOOTSTRAP-DEPLOYMENT-ON-ONE-PAID-PLAN.md` §4

## Context

The database and access layer are **fixed**, not open decisions: MariaDB 11.8 (InnoDB,
strict mode, `utf8mb4`) with Drizzle ORM, the `mysql2` driver, and explicit SQL migrations.
This is driven by `50-BOOTSTRAP` — the funded environment is the owner's Hostinger plan,
whose included database is MariaDB (`11.8.9-MariaDB-log`). PostgreSQL is not available on
it.

> **Correction, 2026-09-12.** Earlier revisions of this ADR named the engine "Hostinger's
> MySQL-compatible MariaDB", following the planning pack. The owner has confirmed the
> engine is MySQL, and the repository agrees: the driver is `mysql2` and every suite runs a
> real MySQL server. MariaDB is used nowhere — not in development, not in test, not in
> deployment. The planning pack still says otherwise and is immutable; the discrepancy is
> the pack's, not the implementation's.

> **Correction, 2026-10-17 (supersedes the note above).** The 2026-09-12 note was wrong
> about production: the owner's Hostinger shared hosting reports `11.8.9-MariaDB-log`, and
> the owner has decided that MariaDB 11.8 is the project's single database engine in every
> environment — `compose.yaml`, the database and end-to-end test harnesses, CI, and
> production. MySQL is no longer a supported target. The driver stays `mysql2` and the
> connection URLs stay `mysql://`. Nothing in the decision below changes: MariaDB, like
> MySQL, has no row-level security, so the five layers stand as written.

This ADR therefore does **not** decide the engine. It decides the thing the pack names as
a requirement but leaves to implementation: **what concretely replaces row-level security.**

MariaDB has no RLS (nor does MySQL). `04-SECURITY-PRIVACY.md` §4 is blunt about the
consequence: "no control may assume it exists." On PostgreSQL, a forgotten
`WHERE organization_id = ?` returns zero rows. On MariaDB, the same omission returns **every
tenant's rows**. The failure
mode inverts from safe to catastrophic, and it is silent — the endpoint works, the tests
that only check the happy path pass, and the leak is invisible until someone notices data
from another customer.

So the question is not "how do we approximate RLS" but "what makes a missing tenant
predicate impossible to ship".

## Decision

Five independent layers. No single one is trusted, and the third is the one that replaces
what RLS was doing.

### 1. Structural — the schema refuses cross-tenant edges

Every tenant-owned table carries `organization_id CHAR(36) NOT NULL`, every tenant parent
carries `UNIQUE KEY (organization_id, id)`, and every child-to-parent relationship uses a
**composite foreign key including `organization_id`** (§5):

```sql
ALTER TABLE work_items
  ADD CONSTRAINT fk_work_items_project_tenant
  FOREIGN KEY (organization_id, project_id)
  REFERENCES projects (organization_id, id);
```

A globally unique id alone is explicitly insufficient. The effect is that a work item in
tenant A cannot reference a project in tenant B — not "should not", cannot. An application
bug that passes the wrong parent id fails at the storage layer rather than quietly
creating a cross-tenant edge.

`organization_id` is immutable after insert, enforced by trigger.

### 2. Credential — the runtime user cannot reshape the database

Separate migration and runtime database users. The runtime user holds only the DML
privileges the application needs and cannot alter schema, grant privileges, create users,
or reach another database (§5). On Hostinger this is applied "where the plan permits"
(`50-BOOTSTRAP` §4); where it does not, the limitation is recorded in the environment
runbook rather than quietly ignored.

### 3. Instrumented — a missing tenant predicate is a hard failure

**This is the RLS replacement.** §6 requires that "development/test query instrumentation
rejects access to tenant tables when a tenant predicate is missing".

Every statement issued through the driver passes a guard that identifies which tenant-owned
tables it touches and asserts the statement carries an `organization_id` predicate bound to
the active `TenantContext`. Behaviour by environment:

| Environment           | On a missing predicate                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| development, test, CI | **Throw.** The test or request fails loudly.                                                                                                            |
| staging, production   | Emit a security event with safe metadata, increment a metric, and throw unless `TENANT_GUARD_MODE=observe` is explicitly set for a documented incident. |

Defaulting production to throw is deliberate. The alternative — log and serve — means the
first occurrence of the bug is also a live data leak. A 500 is recoverable; a
cross-tenant disclosure is not.

### 4. Boundary — the driver is unreachable from feature code

Lint rules ban importing the database handle outside repository and migration modules, and
ban raw SQL outside a small allowlisted, reviewed directory (§6). Repositories expose no
unscoped `findById`, `update`, `delete`, or free-form query; their signatures **require** a
`TenantContext`. Mutations derive `organization_id` from the context and never from the
request DTO, so a caller cannot supply the tenant it wants to write into.

### 5. Adversarial — the isolation corpus proves it

Two seeded organizations with **intentionally similar names and adjacent identifiers**
(§11), exercised across reads, writes, joins, bulk changes, direct-ID enumeration,
suspended membership, expired client membership, and the client-to-client boundary inside
a single tenant. Tests assert both the HTTP outcome and the database side effect — an
endpoint that returns 403 while having already written the row is still a failure.

## Consequences

**Positive**

- The dangerous default is inverted back: a forgotten predicate fails in development
  instead of leaking in production.
- Composite foreign keys make a whole category of bug structurally unrepresentable, and
  they are declarative — reviewable in the migration, not scattered through services.
- Nothing here depends on a database feature Hostinger does not provide, so the bootstrap
  profile and the funded target architecture use identical controls.

**Negative**

- The query guard must parse SQL to find table references and predicates. It can produce
  false positives on unusual-but-legitimate statements. Mitigated by an explicit,
  reviewed escape hatch (`allowUnscoped` with a mandatory reason string, audited) rather
  than by loosening the guard.
- Composite foreign keys widen indexes and require the `(organization_id, id)` unique key
  on every parent. Accepted: the storage cost is small and the index is useful anyway,
  since every real query starts with `organization_id`.
- Five layers cost more than one `CREATE POLICY`. That is the actual price of the engine
  the funded environment provides, and it is worth paying explicitly rather than pretending
  application discipline alone is equivalent.

**Compared with PostgreSQL + RLS**

Weaker in one specific way worth stating plainly: RLS is enforced by the database for
_every_ connection, including a psql session, an ad-hoc script, or a compromised
credential. Layers 1, 2, and 5 hold in those cases; layers 3 and 4 do not, because they
live in the application. Direct database access is therefore a privileged, audited path
(§10), and the runtime credential's inability to reach another database (layer 2) is what
limits the blast radius.

## Revisit trigger

- Move from Hostinger's included database to a funded managed MariaDB service when the
  capacity, backup, recovery, regional, availability, or support gate in `50-BOOTSTRAP` §8
  is passed. The five isolation layers remain mandatory after that move.
- Revisit the guard's SQL parsing if false positives require more than a handful of
  documented escapes.
- If MariaDB ships a usable RLS-equivalent, adopt it as a sixth layer, not a substitute.
