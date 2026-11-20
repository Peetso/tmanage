import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { LeaseStore, LeaseRow } from '../common/database/runtime-lease-store.js';

/**
 * DC-3 / RT-3 — the leader lease of the single Hostinger app.
 *
 * Hostinger can run two copies of the app at once (a restart that overlaps the old process, an
 * on-demand spawn while one still runs). Every copy serves web traffic; only the copy holding this
 * lease runs the singleton duties (the in-process relay, the scheduled sweeps and jobs). The
 * others call {@link LeaderLease.tick} every `renewEveryMs` and take over once the row expires.
 *
 * The rules (AWS Builders' Library, "Leader election in distributed systems"; Kleppmann, "How to
 * do distributed locking", 2016):
 *
 * 1. **One atomic claim.** The row's conditional UPDATE is the only arbiter (`runtime-lease-store`).
 * 2. **Local elapsed time decides "do I still lead?"** {@link LeaderLease.holds} compares the
 *    monotonic clock with a deadline taken BEFORE the claim statement was sent, minus one renewal
 *    period of safety: `start + ttl − renewEvery`. Other copies may take over only at
 *    `start + ttl` by the wall clock, so a holder stops trusting its lease at least `renewEvery`
 *    before anyone else can win it. A wall-clock jump cannot extend it.
 * 3. **Check before every pass, not once.** Duties ask {@link LeaderLease.holds} before each pass
 *    (`apps/server/leadership.mjs`), so a holder that stalls past its deadline starts no new work.
 * 4. **Three outcomes, never two** (AS-4, DC-1): `leader`, `follower` (another live copy holds it)
 *    and `error` (the statement failed; nobody knows). An error does not make this copy a leader,
 *    and does not end a held lease early: the deadline in rule 2 still applies.
 * 5. **Overlap is still harmless.** A pass that began just before the deadline can finish after a
 *    new leader starts. The duties are already safe for that: each sweep runs under its own
 *    MariaDB named lock and the relay claims rows with `FOR UPDATE SKIP LOCKED`. The lease removes
 *    the doubled load and the doubled hourly runs; it is an efficiency lock in Kleppmann's terms.
 *    `generation` (a fencing number) is logged on every change of holder for diagnosis.
 */

/** The one lease name today: the singleton duties of the app. */
export const LEADER_LEASE_NAME = 'leader';
/** The lease length. A crashed leader is replaced at most this long (+ one retry) later. */
export const LEADER_LEASE_TTL_MS = 30_000;
/** Renew (and, for followers, retry) every third of the lease (ADR-0010 §3). */
export const LEADER_LEASE_RENEW_MS = 10_000;

export type LeaseTick =
  | { readonly kind: 'leader'; readonly generation: number; readonly changed: boolean }
  | { readonly kind: 'follower'; readonly holder: string | null; readonly changed: boolean }
  | { readonly kind: 'error'; readonly error: unknown; readonly holds: boolean };

export interface LeaderLease {
  /** This copy's opaque tag (the `holder` column). */
  readonly holder: string;
  /** One claim-or-renew. Never throws: a database error is the `error` outcome. */
  tick(): Promise<LeaseTick>;
  /** True while this copy may start a singleton pass (rule 2). */
  holds(): boolean;
  /** Stop trusting the lease at once and expire the row if this copy holds it. May throw. */
  release(): Promise<void>;
}

export interface LeaderLeaseOptions {
  readonly store: LeaseStore;
  readonly holder: string;
  readonly name?: string;
  readonly ttlMs?: number;
  readonly renewEveryMs?: number;
  /** The wall clock bound into the row. Tests inject it. */
  readonly now?: () => Date;
  /** Monotonic milliseconds for rule 2. Tests inject it. */
  readonly monotonic?: () => number;
}

/** A fresh opaque tag: random, so it names no host, path or pid (it is shown by `/healthz/deep`). */
export function newLeaseHolder(): string {
  return randomBytes(6).toString('hex');
}

export function createLeaderLease(options: LeaderLeaseOptions): LeaderLease {
  const name = options.name ?? LEADER_LEASE_NAME;
  const ttlMs = options.ttlMs ?? LEADER_LEASE_TTL_MS;
  const renewEveryMs = options.renewEveryMs ?? LEADER_LEASE_RENEW_MS;
  const now = options.now ?? (() => new Date());
  const monotonic = options.monotonic ?? (() => performance.now());
  if (!(renewEveryMs > 0) || !(ttlMs > 2 * renewEveryMs)) {
    // The trusted window (ttl − renewEvery) must outlast one renewal period, or a healthy holder
    // would step down between two renewals.
    throw new RangeError('leader lease: ttlMs must be more than twice renewEveryMs');
  }
  let validUntil = Number.NEGATIVE_INFINITY;
  let lastKind: 'leader' | 'follower' | undefined;
  let lastHolder: string | null | undefined;

  const holds = (): boolean => monotonic() < validUntil;

  return {
    holder: options.holder,
    holds,
    async tick(): Promise<LeaseTick> {
      const startedAt = monotonic();
      const wall = now();
      try {
        const result = await options.store.claim(
          name,
          options.holder,
          wall,
          new Date(wall.getTime() + ttlMs),
        );
        if (result.won) {
          validUntil = startedAt + ttlMs - renewEveryMs;
          const changed = lastKind !== 'leader';
          lastKind = 'leader';
          lastHolder = options.holder;
          return { kind: 'leader', generation: result.generation, changed };
        }
        validUntil = Number.NEGATIVE_INFINITY;
        const holder = liveHolder(result.row, wall);
        const changed = lastKind !== 'follower' || lastHolder !== holder;
        lastKind = 'follower';
        lastHolder = holder;
        return { kind: 'follower', holder, changed };
      } catch (error) {
        return { kind: 'error', error, holds: holds() };
      }
    },
    async release(): Promise<void> {
      const held = lastKind === 'leader';
      validUntil = Number.NEGATIVE_INFINITY;
      lastKind = undefined;
      if (held) await options.store.release(name, options.holder, now());
    },
  };
}

/** The other copy's tag while its row is live; `null` when the row is missing or expired. */
function liveHolder(row: LeaseRow | null, wall: Date): string | null {
  if (row === null || row.holder === '') return null;
  return row.expiresAt.getTime() >= wall.getTime() ? row.holder : null;
}
