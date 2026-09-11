# TManage

A multi-tenant Work Operating System for service teams and their clients: one governed
loop from client request through triage, execution, internal review, client review, and
approval, to final delivery — with internal discussion staying internal.

**Status:** early implementation. Foundations and the authorization/domain core are built
and tested; the MySQL data layer is the next task. See
[`docs/implementation-status.md`](docs/implementation-status.md) for what is actually
verified, and never assume a check passed unless it is recorded there.

## Getting started

Requires **Node ≥ 22.12** and **pnpm ≥ 10.15**.

```bash
pnpm install
```

```bash
cp .env.example .env
```

Every value in `.env.example` is a safe local placeholder. Nothing real belongs in it.

### Run the checks that currently exist

```bash
pnpm -r test
```

```bash
pnpm audit:design
```

### Local infrastructure

With a container runtime:

```bash
docker compose up -d --wait
```

This starts MySQL 8.4, Valkey 8.1, and MinIO — mirroring the bootstrap deployment
profile (Hostinger MySQL, Upstash Redis, Cloudflare R2). Then, in order:

```bash
pnpm db:migrate
```

```bash
pnpm db:grants
```

The order is not stylistic. `scripts/db/users.sql` creates the least-privilege runtime and
worker users (ADR-0001 layer 2) with table-level grants, and MySQL rejects a table-level
`GRANT` naming a table that does not exist. `db:grants` also needs an
administrative credential — it issues `CREATE USER` and `GRANT`, which the migration user
deliberately cannot do — so point `DATABASE_MIGRATION_URL` at an admin user for that command
only.

Without a container runtime, the database tests fall back to an embedded MySQL server and
the filesystem/in-memory drivers. See
[`ADR-0002`](docs/adr/ADR-0002-local-development-substitutes.md) for the fidelity limits —
they are real and are recorded per driver. The least-privilege suite skips in that mode and
says so; CI is where it runs.

## Architecture

pnpm TypeScript monorepo. Next.js App Router for the team app and the dedicated client
portal; NestJS + Fastify as a modular-monolith API; MySQL as the system of record, on
Hostinger; Drizzle ORM with `mysql2` and explicit SQL migrations; a
Redis-compatible service for cache, rate limits, presence, and BullMQ; S3-compatible
private object storage.

```text
apps/       web · api · worker
packages/   ui · contracts · domain · config · observability · test-kit
docs/       planning (immutable) · design (immutable source + audit) · adr · product · runbooks
infra/      environments · modules · containers
```

Boundary rules from `18-REPOSITORY-STRUCTURE.md` are enforced as **lint errors**, not
conventions: feature UI cannot import API internals, and `packages/domain` cannot import
a framework, a driver, or another workspace package.

## Tenant isolation

The single property this product cannot get wrong.

MySQL has no row-level security, so isolation rests on five independent layers described
in [`ADR-0001`](docs/adr/ADR-0001-tenant-isolation-without-rls.md):

1. **Structural** — composite `(organization_id, id)` foreign keys make a cross-tenant row
   reference impossible to represent.
2. **Credential** — the runtime database user holds DML privileges only.
3. **Instrumented** — a query touching a tenant table without an `organization_id`
   predicate throws.
4. **Boundary** — lint rules keep the driver unreachable from feature code.
5. **Adversarial** — an isolation corpus with two deliberately similar organizations.

Layer 3 is the direct replacement for what RLS was doing. Read the ADR before changing
anything in `apps/api/src/common/database/`.

## Working on this repository

Read [`docs/planning/15-AI-EXECUTION-HANDBOOK.md`](docs/planning/15-AI-EXECUTION-HANDBOOK.md)
first — it sets the precedence order that resolves conflicts between sources.
[`docs/product/source-map.md`](docs/product/source-map.md) records which file governs which
decision.

`docs/planning/` and `docs/design/source/` are **immutable copies** of the planning pack and
the completed design export. Do not edit them. They have been revised mid-implementation
before; re-check them against the originals before resuming work.

Everything in the design system is deliberate. The design export pairs Satoshi for display
and UI with Manrope for paragraphs, Alexandria for Arabic, and Geist Mono for IDs, hashes and
metadata — but **the application ships Manrope for both Latin roles**, because the Fontshare
EULA forbids serving Satoshi from our own origin without written consent. See
[ADR-0005](docs/adr/ADR-0005-manrope-is-the-latin-typeface.md). Lime means
_current / next / live_ — never success, never decoration — and text on lime is always ink.
Cards use borders; shadows are for real overlays only.
