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

| Dependency     | Canonical (`compose.yaml`) | Deployed (bootstrap) | Local substitute                                                                             | Fidelity                                                |
| -------------- | -------------------------- | -------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Database       | `mysql:8.4.11`             | Hostinger MySQL      | `mysql-memory-server` — downloads and runs a **real** MySQL server binary as a child process | **Full engine**, unpinned version — see the engine note |
| Cache/queue    | `valkey:8.1`               | Upstash Redis Free   | in-process `memory` driver                                                                   | Partial                                                 |
| Object storage | MinIO                      | Cloudflare R2        | `filesystem` driver                                                                          | Partial                                                 |

Selection is by environment variable (`QUEUE_DRIVER`, `CACHE_DRIVER`, `STORAGE_DRIVER`),
validated by `packages/config`.

### The database substitute is not a compromise

This is the load-bearing part. `mysql-memory-server` runs a genuine MySQL server, so the
substitute exercises real InnoDB, real composite foreign keys, real strict mode, real
transaction and locking semantics, and the real migration SQL. Every control ADR-0001
depends on is therefore genuinely under test.

An in-memory SQL emulator was rejected outright: composite foreign keys and strict-mode
behaviour are precisely what layer 1 of ADR-0001 relies on, and an emulator that accepts
the DDL without enforcing it would make the isolation suite pass while proving nothing —
worse than not running it.

**Engine note.** One engine, everywhere: MySQL. The substitute is MySQL, `compose.yaml` is
MySQL, and the deployed database is MySQL. There is therefore no _engine_ skew for CI to
close, and the containerised run earns its place on other grounds — the server start-up
flags, the provisioned least-privilege users, and Valkey and MinIO beside the database.

**Version skew remains, and is not zero.** `compose.yaml` pins `mysql:8.4.11`; the embedded
substitute (`apps/api/test/support/test-database.ts`) pins no version at all, so it runs
whatever `mysql-memory-server` selects on the machine — MySQL 8.0.45 on the implementation
machine as of 2026-09-12, because that server is installed here. Across the 8.0 → 8.4
boundary the default authentication plugin, the optimiser's plan choices, and parts of
`information_schema` all differ; `apps/api/test/test-002-performance.db.test.ts` already
records the optimiser half in its own docstring. Fidelity of the substitute is therefore
full at the level of the engine and its semantics, not at the level of the release series.

> **Correction, 2026-09-12.** Earlier revisions of this ADR said the substitute was MySQL
> while the deployed database was MariaDB, and that CI was the only place that skew was
> caught. Those claims were wrong as written, not merely overtaken: they restated the
> planning pack's hosting assumption instead of the stack, and no MariaDB was ever used by
> this project. The owner has confirmed MySQL is the only engine. What survives the
> correction is the version-skew note above, which is a real limit and replaces the
> engine-skew caveat this revision removed.

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
  this machine today, against a real MySQL server.
- The driver ports are required regardless: they are the same seam `50-BOOTSTRAP` §9
  mandates for keeping storage, database, queue, email, and telemetry replaceable, and the
  same seam that carries the product from the bootstrap profile to the funded topology.

**Negative**

- Two code paths per dependency, both needing maintenance. Mitigated by a shared contract
  test suite every driver of a port must pass.
- MySQL **release-series** skew between the embedded substitute and `compose.yaml`, because
  the substitute pins no version — see the engine note above. Closed by pinning the
  embedded server to the compose version, which needs a full database-suite run to land.
- First test run downloads a MySQL binary (cached under `.local/`).

## Revisit trigger

Remove the `memory` and `filesystem` substitutes once CI and every developer machine has a
container runtime. Keep the ports. Keep the embedded server for local runs regardless — it
is materially faster than a container round-trip and it is the same engine as the deployed
database, so what is traded away by preferring it is the release series, not the engine.
Pin its version to the one `compose.yaml` runs when a full database-suite run is available
to prove the pin, and that last gap closes too.
