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

| Dependency     | Canonical (`compose.yaml`) | Deployed (bootstrap) | Local substitute                                                                             | Fidelity |
| -------------- | -------------------------- | -------------------- | -------------------------------------------------------------------------------------------- | -------- |
| Database       | `mariadb:11.4`             | Hostinger MariaDB    | `mysql-memory-server` — downloads and runs a **real** MySQL server binary as a child process | **Full** |
| Cache/queue    | `valkey:8.1`               | Upstash Redis Free   | in-process `memory` driver                                                                   | Partial  |
| Object storage | MinIO                      | Cloudflare R2        | `filesystem` driver                                                                          | Partial  |

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

**Engine note.** The substitute is MySQL; the deployed database is MariaDB. They diverge on
features this schema deliberately avoids (no `CHECK` reliance beyond both engines' support,
no engine-specific JSON functions in tenant-critical paths, no `RETURNING`). CI runs
MariaDB via `compose.yaml`, so any divergence is caught there rather than only at deploy.
This gap is recorded in `docs/implementation-status.md` against every check it affects.

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
- MySQL-vs-MariaDB engine skew between local and deployed, addressed by CI as above.
- First test run downloads a MySQL binary (cached under `.local/`).

## Revisit trigger

Remove the `memory` and `filesystem` substitutes once CI and every developer machine has a
container runtime. Keep the ports. Keep the embedded server for local runs regardless — it
is materially faster than a container round-trip and, for MySQL-vs-MariaDB, switch it to an
embedded MariaDB if one becomes available so local and deployed engines match exactly.
