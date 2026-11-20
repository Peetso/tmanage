# ADR-0010 — The single Hostinger app is correct with N ≥ 1 overlapping instances; singleton duties run under a DB leader lease

- **Status:** Proposed (lane B, 2026-11-20)
- **Date:** 2026-11-20
- **Deciders:** Implementation lead; design review Fable 5.2
- **Rules affected:** RT-2, RT-3, RT-4, RT-5, RT-6, AS-4; **bends a rule:** no
- **Quality scenarios:** QA-AV-1, QA-AV-2
- **Evidence:** DC-3 (a second Node process after every deploy up to 2026-11-20; memory "Restart Hostinger quietly"). `apps/server/server.mjs:612-699` (boot order, no single-instance mechanism). `apps/server/web-transport.mjs:83-86` (fixed socket `.run/web.sock`). `web-socket-preload.mjs:40` and `web-transport.mjs:125` (unlink on start and on exit). `scheduled-sweeps.mjs:591-597` (in-memory throttles). `realtime-inprocess.mjs:1` (per-process hub).

## Context

Hostinger documents its Node.js apps as **run on demand**: stopped when idle, restarted by the next request, restarted on crash (https://docs.hostinger.com/node.js/overview). It does not document the launcher or promise a single instance. Process managers of this kind (for comparison, Phusion Passenger: `PassengerMinInstances`, `PassengerMaxPoolSize` default 6) spawn another instance when none is ready to take a request. TManage's boot holds requests for up to 30 s (`web-transport.mjs:370`) and only becomes ready after the worker and sweeps have started (`server.mjs:692-699`). On shutdown, an instance may linger up to 120 s behind the migration gate (`migration-shutdown.mjs:20`). Both windows invite a second instance.

The code assumes one process. That assumption breaks in three ways:

- **The socket collides.** The new instance unlinks the old one's socket, and the old one's exit unlinks the new one's. The result is a 502 on every page.
- **In-memory throttles double-run** their hourly jobs.
- **Realtime pushes miss** clients connected to the other instance.

The operator workaround ("wait 3 min, send one request") treats a design defect as a procedure (memory "Peter rules spirit, not loopholes").

## Decision

1. **Assume N ≥ 1 instances** (Twelve-Factor VI, VIII, IX). An instance-unique resource is either per-instance or held in the DB.
2. **Per-instance web socket**: always use the `mkdtemp` directory (already supported when `temp: true`, `web-transport.mjs:88,98`). An instance unlinks only its own path.
3. **Leader lease** for the worker relay, sweeps and the realtime fan-out source. A dedicated DB connection holds `GET_LOCK('tmanage:leader', 0)` (released by MariaDB when the connection dies), or a `leases` row with `expires_at` renewed every ⅓ period. Non-leaders serve HTTP only and retry the lease each period. Hourly throttles move to `job_runs` in the DB.
4. **Readiness = API + web child**; the worker and sweeps start after ready (RT-4). Add `/livez` (RT-5).
5. **Bounded shutdown**: stop accepting, drain ≤ 10 s (proposed), `closeIdleConnections()`, release the lease, exit. Only a migration in progress extends the budget.
6. Realtime across instances: the leader publishes, and each instance polls a small `realtime_events` table (or the outbox) and pushes to its own sockets. This is P1; until then, deep health reports `realtime: instance-local`.

## Alternatives considered

| Option                                                          | Pros       | Cons                                                                                  | Why not chosen     |
| --------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------- | ------------------ |
| Pid or lock file; the second instance exits at once             | simple     | the launcher sees a crash and respawns; the request is lost; a stale file blocks boot | fights the host    |
| Second instance refuses all traffic (503) until the first exits | one writer | users see 503 on every deploy; the launcher may spawn more                            | worse availability |
| Keep the operator ritual                                        | no code    | a procedure standing in for a design; fails unattended                                | rule RT-10         |

## Consequences

- Good: restarts need no ritual; a duplicate instance is harmless; sweeps run once.
- Cost: lease code + tests; the realtime fan-out redesign (P1).
- Risk: the dedicated lease connection takes one of the 25 per-user DB connections (`docs/ops/hostinger-profile.md`); it is counted in the pool budget (ST-5).

## Fitness functions

| Rule | Check                                                | Exists / to build |
| ---- | ---------------------------------------------------- | ----------------- |
| RT-2 | two-instance boot test in `apps/server`              | to build          |
| RT-3 | leader-lease db test (one pass; takeover)            | to build          |
| RT-4 | slow-worker boot test                                | to build          |
| RT-6 | SIGTERM with a keep-alive client exits within budget | to build          |
