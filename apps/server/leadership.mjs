// DC-3 / RT-3 — which copy of this app runs the singleton duties.
//
// Hostinger can run two copies of the one Node app at once after a deploy or a restart, and we
// cannot stop it (ARCH-REVIEW DC-3). So the app is made safe with N copies: EVERY copy serves web
// traffic, and only the copy holding the leader lease (`runtime_leases`, migration 0384; the state
// machine is `apps/worker/src/leadership/leader-lease.ts`) runs the in-process outbox relay, the
// scheduled sweeps and the worker's scheduled jobs. The others retry the lease every renewal
// period and take over within one lease length after the leader dies, or at once after a clean
// shutdown (the leader expires its own row).
//
// Two gates, both asked before every pass (AWS Builders' Library: check the lease before each
// operation, never once at start):
//
//   * `leaderGatedLock(lock, holds)` wraps the sweeps' named-lock runner, which every sweep and
//     job already passes through (S-7, scheduled-sweeps.test.mjs "lock per job"). A copy that does
//     not lead reports `{ ran: false }`, the same as "another process holds the named lock".
//   * the in-process relay tick asks `holds()` itself (server.mjs).
//
// The duties start the first time this copy leads (`onLeader`, once) and are never torn down and
// rebuilt on a flap: a copy that loses the lease keeps its timers, and each pass is refused by the
// gate until it leads again.
import { clearTimeout, setTimeout } from 'node:timers';

/** The log line for a tick, or `undefined` when nothing changed. Pure: unit-tested. */
export function describeLeaseTick(tick, holder, previousError) {
  if (tick.kind === 'leader') {
    return tick.changed
      ? `leader lease: this copy (${holder}) leads, generation ${String(tick.generation)}; ` +
          'relay, sweeps and jobs run here'
      : previousError
        ? `leader lease: renewed again by this copy (${holder})`
        : undefined;
  }
  if (tick.kind === 'follower') {
    if (!tick.changed && !previousError) return undefined;
    return tick.holder === null
      ? `leader lease: no live leader yet; this copy (${holder}) retries`
      : `leader lease: copy ${tick.holder} leads; this copy (${holder}) serves web traffic only`;
  }
  return undefined;
}

/**
 * The lease loop. `lease` is the worker's `createLeaderLease(...)`; `onLeader` starts the duties
 * (called once, the first time this copy leads). `timers` is injectable for tests.
 */
export function createLeadership({
  lease,
  intervalMs,
  log,
  describeError = (error) => String(error),
  onLeader = async () => undefined,
  timers = { setTimeout, clearTimeout },
}) {
  let timer;
  let inFlight;
  let stopped = false;
  let started = false;
  let inError = false;
  let duties;

  async function tickOnce() {
    const tick = await lease.tick();
    if (tick.kind === 'error') {
      // AS-4: "the lease query failed" is not "another copy leads"; it is logged as an error,
      // once per spell, with whether this copy still trusts a lease it held.
      if (!inError) {
        log(
          `leader lease: claim failed (${describeError(tick.error)}); ` +
            (tick.holds
              ? 'this copy keeps leading until its lease deadline'
              : 'this copy runs no singleton duty until the database answers'),
        );
      }
      inError = true;
      return tick;
    }
    const line = describeLeaseTick(tick, lease.holder, inError);
    inError = false;
    if (line !== undefined) log(line);
    if (tick.kind === 'leader' && !started && !stopped) {
      started = true;
      // Not awaited: starting the duties must never delay the next renewal.
      duties = Promise.resolve()
        .then(onLeader)
        .catch((error) => log(`leader duties failed to start: ${describeError(error)}`));
    }
    return tick;
  }

  function schedule() {
    if (stopped) return;
    timer = timers.setTimeout(() => {
      inFlight = tickOnce().finally(() => {
        inFlight = undefined;
        schedule();
      });
    }, intervalMs);
    timer?.unref?.();
  }

  return {
    holds: () => !stopped && lease.holds(),
    /** One claim now, outside the timer (tests drive the loop with it). */
    tick: () => tickOnce(),
    /** Resolves once the duties `onLeader` started have finished starting (or at once). */
    dutiesStarted: () => duties ?? Promise.resolve(),
    /** First claim now (awaited, so boot logs who leads), then every `intervalMs`. */
    async start() {
      if (timer !== undefined || stopped) return;
      inFlight = tickOnce();
      try {
        await inFlight;
      } finally {
        inFlight = undefined;
      }
      schedule();
    },
    /**
     * Stop claiming, wait for a claim in flight, then expire the row if this copy holds it, so
     * the next copy leads at once. Call after the duties have stopped.
     */
    async stop() {
      stopped = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      await inFlight?.catch(() => undefined);
      try {
        await lease.release();
      } catch (error) {
        log(`leader lease: release failed (${describeError(error)}); it expires on its own`);
      }
    },
  };
}

/**
 * The sweeps' named-lock runner, refused while this copy does not lead. Same shape as the
 * worker's `SweepLock` (`run`, `end`), so `createSweepScheduler`, `lockedPass` and every
 * `start*` function take it unchanged.
 */
export function leaderGatedLock(lock, holds) {
  return {
    async run(name, work) {
      if (!holds()) return { ran: false };
      return lock.run(name, work);
    },
    end: () => lock.end(),
  };
}
