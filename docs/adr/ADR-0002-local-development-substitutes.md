# ADR-0002 — Local development substitutes when no container runtime is present

- **Status:** Accepted
- **Date:** 2026-08-16
- **Deciders:** Implementation lead
- **Governing sources:** `50-BOOTSTRAP-DEPLOYMENT-ON-ONE-PAID-PLAN.md` §9;
  `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §11; `28-SPRINT-TICKETS` PLAT-002

## Context

`50-BOOTSTRAP` §9 requires that "CI and local development use containers/mocks without
contacting production free-tier accounts". `compose.yaml` is the canonical local stack and
is committed.

The implementation machine has **Node 22.22.0, npm 11, git — and no Docker, no container
runtime, no WSL distribution, and no local MySQL** (verified 2026-08-16). Installing a
container runtime is a machine-level change outside an implementation task; provisioning
cloud infrastructure needs owner authorization that has not been given. Contacting the
Hostinger or Upstash free-tier accounts from a dev machine is forbidden by §9 anyway.

Without a resolution the isolation corpus in `25-AUTH-AND-TENANT-ISOLATION` §11 cannot run.
Given that ADR-0001 places the tenant guarantee in application-layer controls rather than
in the database engine, **being unable to run the isolation tests would mean the guarantee
is only asserted, never demonstrated.** That is not acceptable for the one property this
product cannot get wrong.

## Decision

A driver port per infrastructure dependency. The containerised service is the default; a
no-container substitute is available for development and test only.

| Dependency     | Canonical (`compose.yaml`) | Deployed (bootstrap)           | Local substitute                                                                                                       | Fidelity                                                   |
| -------------- | -------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Database       | MariaDB 11.8 (`mariadb`)   | Hostinger `11.8.9-MariaDB-log` | `scripts/db/mariadb-server.mjs` — runs a **real** portable MariaDB 11.8.9 server as a child process, one per test file | **Full engine, same release series** — see the engine note |
| Cache/queue    | `valkey:8.1`               | Upstash Redis Free             | in-process `memory` driver                                                                                             | Partial                                                    |
| Object storage | MinIO                      | Cloudflare R2                  | `filesystem` driver                                                                                                    | Partial                                                    |

Selection is by environment variable (`QUEUE_DRIVER`, `CACHE_DRIVER`, `STORAGE_DRIVER`),
validated by `packages/config`.

### The database substitute is not a compromise

This is the load-bearing part. `scripts/db/mariadb-server.mjs` runs a genuine MariaDB
server, so the substitute exercises real InnoDB, real composite foreign keys, real strict mode, real
transaction and locking semantics, and the real migration SQL. Every control ADR-0001
depends on is therefore genuinely under test.

An in-memory SQL emulator was rejected outright: composite foreign keys and strict-mode
behaviour are precisely what layer 1 of ADR-0001 relies on, and an emulator that accepts
the DDL without enforcing it would make the isolation suite pass while proving nothing —
worse than not running it.

**Engine note.** One engine, everywhere: MariaDB 11.8. The substitute is MariaDB 11.8.9,
`compose.yaml` runs an exact `mariadb:11.8.x` image, and the deployed database is Hostinger's
`11.8.9-MariaDB-log`. There is therefore neither _engine_ nor _release-series_ skew for CI to
close, and the containerised run earns its place on other grounds — the server start-up
flags, the provisioned least-privilege users, and Valkey and MinIO beside the database.

**How the substitute is provided.** The database harness
(`apps/api/test/support/test-database.ts`) and the end-to-end stack start a private MariaDB
11.8.9 server per test file through `scripts/db/mariadb-server.mjs`. On first use that
script extracts the official, sha256-checked MariaDB 11.8.9 Windows ZIP into
`.local/mariadb` and reuses it afterwards; `TMANAGE_MARIADB_HOME` points it at an existing
runtime instead. The portable runtime is Windows-only: on Linux, and in CI, set
`TMANAGE_TEST_DATABASE_URL` to the MariaDB that `compose.yaml` starts.

> **Correction, 2026-09-12.** Earlier revisions of this ADR said the substitute was MySQL
> while the deployed database was MariaDB, and that CI was the only place that skew was
> caught. Those claims were wrong as written, not merely overtaken: they restated the
> planning pack's hosting assumption instead of the stack, and no MariaDB was ever used by
> this project. The owner has confirmed MySQL is the only engine. What survives the
> correction is the version-skew note above, which is a real limit and replaces the
> engine-skew caveat this revision removed.

> **Correction, 2026-10-17.** The 2026-09-12 correction was itself wrong about production:
> Hostinger's shared hosting runs `11.8.9-MariaDB-log`, so the project was running MySQL
> locally and in CI against a MariaDB production. The owner has decided MariaDB 11.8 is the
> single standard engine everywhere, and MySQL is no longer a supported target. Until this
> revision the canonical image was `mysql:8.4.11` and the substitute was
> `mysql-memory-server`, an unpinned embedded MySQL (8.0.45 on the implementation machine),
> which carried both an engine skew against production and a MySQL 8.0 → 8.4
> release-series skew against `compose.yaml`. Both skews are gone: the substitute is now the
> portable MariaDB 11.8.9 from `scripts/db/mariadb-server.mjs`, cached under
> `.local/mariadb` — the same engine and series as `compose.yaml` and production. The
> driver stays `mysql2`; `mysql://` URLs are that driver's scheme, not a claim about the
> server.

### Guardrails

1. `packages/config` **refuses to boot** when `NODE_ENV=production` and any driver is
   `memory` / `filesystem` / `stub`. A validation error at process start, not a warning.
2. CI runs the canonical containerised stack. Substitutes are never the evidence path for
   a release gate.
3. `docs/implementation-status.md` records which driver each verification ran against, so
   no claim is ambiguous about its fidelity.

### Known fidelity limits of the partial substitutes

Recorded so they are never mistaken for coverage:

- **Queue (`memory`)** — no cross-process delivery, no persistence, no BullMQ stalled-job
  recovery. Outbox at-least-once delivery, consumer idempotency, and retry ordering are
  _logic_ and are tested here; **durability and failover are not**, and must be verified
  against Valkey/Upstash (ticket REL-001). `50-BOOTSTRAP` §4 additionally flags that
  Upstash idle polling consumes the free command allowance — a bootstrap-specific concern
  the memory driver cannot surface at all.
- **Cache (`memory`)** — no eviction under pressure, no cross-instance coherence. Cache-key
  tenant scoping is testable; distributed invalidation is not.
- **Storage (`filesystem`)** — presigned URLs are locally HMAC-signed tokens served by the
  API, not S3 signatures. Key namespacing, quarantine gating, TTL expiry, and scan-state
  enforcement are testable; real R2 signature semantics, versioning, and lifecycle rules
  are not (ticket FILE-003).

## Consequences

**Positive**

- The isolation corpus, composite foreign keys, and migrations are genuinely verifiable on
  this machine today, against a real MariaDB 11.8 server — the production engine and series.
- The driver ports are required regardless: they are the same seam `50-BOOTSTRAP` §9
  mandates for keeping storage, database, queue, email, and telemetry replaceable, and the
  same seam that carries the product from the bootstrap profile to the funded topology.

**Negative**

- Two code paths per dependency, both needing maintenance. Mitigated by a shared contract
  test suite every driver of a port must pass.
- The portable MariaDB runtime is Windows-only. Linux machines and CI run the suites against
  `compose.yaml`'s MariaDB through `TMANAGE_TEST_DATABASE_URL`.
- First test run extracts the MariaDB 11.8.9 runtime into `.local/mariadb` (or uses
  `TMANAGE_MARIADB_HOME`).

## Revisit trigger

Remove the `memory` and `filesystem` substitutes once CI and every developer machine has a
container runtime. Keep the ports. Keep the portable MariaDB server for local runs
regardless — it is materially faster than a container round-trip and it is the same engine
and release series as `compose.yaml` and the deployed database, so nothing is traded away
by preferring it. Move all three together when production's MariaDB series changes.

## Amendment 2026-10-17 — a `local` storage driver for single-host production

The bootstrap deployment target is Hostinger shared hosting: one Node process per
subdomain, no object store on the plan, and Cloudflare R2 not yet provisioned. Customer
files still need somewhere to live.

**The `filesystem` substitute stays development-only.** Guardrail 1 is unchanged: it is
refused when `NODE_ENV=production`.

A **distinct driver name, `local`**, reuses the same `FilesystemObjectStore` for production
on a single host. A separate name keeps the development substitute and the production path
apart in configuration, logs, and review, so the refusal above never needs an exception.
It is accepted in production only under these guards:

1. **Root outside any web root.** `STORAGE_LOCAL_ROOT` must be absolute and must not lie
   inside `public_html`, `public`, `www`, or `htdocs`. Checked at config load and again on
   disk at boot, after resolving symlinks; either failure refuses to start.
2. **Traversal-safe key → path.** Keys containing `..`, an absolute path, NUL, or a
   backslash are rejected; the resolved path is realpath-checked to sit under the root.
3. **Tenant-bound, short-lived upload tokens.** Part-upload links are HMAC-signed `pu2`
   tokens bound to the tenant, signed with `STORAGE_LOCAL_SIGNING_SECRET`, within the
   existing TTL and size/type limits.
4. **No direct file serving.** Downloads go only through the authenticated, proxied
   download routes, which apply the existing permission checks.

S3/R2 remains the target driver and the default (`STORAGE_DRIVER=s3`). The fidelity limits
recorded above for `filesystem` apply equally to `local`; moving to R2 is a configuration
change plus a one-time copy of the root, not a code change.
