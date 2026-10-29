import { createHmac } from 'node:crypto';

/**
 * 56-05 — the one durable limiter (56-SECURITY-AND-TRUST-PLAN §56-05, §5.8).
 *
 * The limiter in `common/http/rate-limiter.ts` lives in process and forgets every window on a
 * restart. A Hostinger restart is routine (a deploy, an idle recycle), so a flood that waits for
 * one gets a fresh budget. This limiter keeps its windows in MariaDB (`rate_limit_buckets`, 0250)
 * through a {@link BucketStore}, which is the only part that touches the database; everything here
 * is arithmetic and is what the unit tests exercise.
 *
 * ## Shape
 *
 * - A **policy** names a route family (`intake_submit`, `contact_submit`, …) and carries up to two
 *   windows — one minute and one hour, the plan's "1-min + 1-hour windows" — and the key the budget
 *   is charged to (`ip`, `link`, `ip+link`, `token`).
 * - **Two-phase, all or nothing.** Every bucket a request would charge (each window × each key) is
 *   asked and charged as one unit by the store: if any of them refuses, none is charged. That is
 *   `sign-in-abuse-control.ts`'s rule (re-review N-1): a refused attempt must not spend the budgets
 *   that would have admitted it.
 * - **Fixed, aligned windows.** A window starts at `floor(now / size) * size`, so every process on
 *   the host agrees on it without coordination, and a reset is simply the next window's key.
 * - **Fail open or closed, per policy.** When the store cannot be reached, a `closed` policy refuses
 *   (sign-up, password reset, intake submissions, approver-link guesses — a flood must not ride an
 *   outage), and an `open` policy falls back to an in-process store so a public read keeps working
 *   with at least the same budget per process.
 * - **Privacy.** A raw key (an address, a link token) is never stored: it is HMACed with a pepper
 *   that changes every UTC day, so a bucket row cannot be joined to an address after the day ends
 *   and rows are swept after two hours (plan §56-05 "hashed with a daily pepper, kept ≤ 48 h").
 *   The day change re-keys every bucket once a day; at worst a caller gets one extra window at UTC
 *   midnight, never a smaller one.
 */

/**
 * What a budget is charged to. Per-organization budgets are not keyed here: the guard runs before
 * the tenant is resolved, so they are `org-quotas.ts`, charged by the code that knows the org.
 */
export type ThrottleKeyKind = 'ip' | 'link' | 'ip+link' | 'token';

export interface ThrottleLimits {
  /** Requests admitted per key per aligned minute. Omit for no minute window. */
  readonly perMinute?: number;
  /** Requests admitted per key per aligned hour. Omit for no hour window. */
  readonly perHour?: number;
  /** What the budget is charged to. `ip+link` charges both, all or nothing. */
  readonly key: ThrottleKeyKind;
  /** The route parameter holding the link token for `link` / `ip+link` keys. Default `token`. */
  readonly linkParam?: string;
  /** What happens when the bucket store is unreachable. Default `closed`. */
  readonly onStoreError?: 'open' | 'closed';
  /**
   * Exempt from the anonymous circuit breaker. For the anonymous routes members depend on to
   * stay signed in (session refresh): "members keep working" while the public door degrades.
   */
  readonly breakerExempt?: boolean;
}

export interface ThrottlePolicy extends ThrottleLimits {
  /** Stable lowercase name, part of every bucket key. */
  readonly name: string;
}

/** The raw values a request offers for each key kind; absent ones are simply `undefined`. */
export interface ThrottleSubject {
  readonly ip?: string | undefined;
  readonly link?: string | undefined;
  readonly token?: string | undefined;
}

/** One bucket a request charges: its stored key, the window it belongs to and its ceiling. */
export interface BucketCharge {
  readonly bucketKey: string;
  readonly windowStart: Date;
  readonly windowMs: number;
  readonly max: number;
}

export interface BucketChargeResult {
  /** `true` when every bucket was charged; `false` when at least one refused and none moved. */
  readonly admitted: boolean;
  /** The count each bucket would hold after this charge, in the order the charges were given. */
  readonly counts: readonly number[];
}

/**
 * Where windows are kept. The MariaDB implementation is `rate-limit-buckets.repository.ts`; the
 * in-process one below is both the fail-open fallback and the test double.
 */
export interface BucketStore {
  /** Ask and charge every bucket as one unit: all are charged, or none is. */
  chargeAll(charges: readonly BucketCharge[], at: Date): Promise<BucketChargeResult>;
  /** Drop buckets not touched since `before`; returns how many went. Bounded by `limit`. */
  sweep(before: Date, limit: number): Promise<number>;
}

export type ThrottleDecision =
  | { readonly admitted: true; readonly degraded: boolean }
  | {
      readonly admitted: false;
      readonly reason: 'limit' | 'store_unavailable' | 'circuit_open';
      readonly retryAfterSeconds: number;
    };

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
/** `bucket_key` is VARCHAR(190); names are bounded so a key always fits. */
const POLICY_NAME = /^[a-z][a-z0-9_]{0,47}$/u;
/** Retry-After sent when the store is down and the policy fails closed. */
export const STORE_UNAVAILABLE_RETRY_SECONDS = 60;

export function assertValidPolicy(policy: ThrottlePolicy): void {
  if (!POLICY_NAME.test(policy.name)) {
    throw new Error(`throttle policy name '${policy.name}' must match ${POLICY_NAME.source}`);
  }
  if (policy.perMinute === undefined && policy.perHour === undefined) {
    throw new Error(`throttle policy '${policy.name}' sets neither perMinute nor perHour`);
  }
  for (const limit of [policy.perMinute, policy.perHour]) {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new Error(
        `throttle policy '${policy.name}' has a limit that is not a positive integer`,
      );
    }
  }
}

/** The day pepper: HMAC(secret, UTC day). A new day re-keys every bucket. */
export function dailyPepper(secret: string, at: Date): Buffer {
  return createHmac('sha256', secret)
    .update(`rate-limit:${at.toISOString().slice(0, 10)}`)
    .digest();
}

/** A raw key value as it is stored: peppered, hashed, 32 url-safe characters. */
export function hashSubject(pepper: Buffer, kind: string, raw: string): string {
  return createHmac('sha256', pepper)
    .update(`${kind}\u0000${raw}`)
    .digest('base64url')
    .slice(0, 32);
}

export function windowStartFor(at: Date, windowMs: number): Date {
  return new Date(Math.floor(at.getTime() / windowMs) * windowMs);
}

/**
 * Every bucket `policy` charges for `subject` at `at`. A key kind whose value is missing charges a
 * shared `none` bucket rather than nothing, so a request that strips its link parameter is still
 * counted — never exempted.
 */
export function bucketsFor(
  policy: ThrottlePolicy,
  subject: ThrottleSubject,
  at: Date,
  pepper: Buffer,
): BucketCharge[] {
  const kinds: (keyof ThrottleSubject)[] =
    policy.key === 'ip+link' ? ['ip', 'link'] : [policy.key as keyof ThrottleSubject];
  const windows: { label: string; ms: number; max: number }[] = [];
  if (policy.perMinute !== undefined)
    windows.push({ label: 'm', ms: MINUTE_MS, max: policy.perMinute });
  if (policy.perHour !== undefined) windows.push({ label: 'h', ms: HOUR_MS, max: policy.perHour });

  const charges: BucketCharge[] = [];
  for (const kind of kinds) {
    const raw = subject[kind];
    const hashed = raw === undefined || raw === '' ? 'none' : hashSubject(pepper, kind, raw);
    for (const window of windows) {
      charges.push({
        bucketKey: `${policy.name}:${kind}:${window.label}:${hashed}`,
        windowStart: windowStartFor(at, window.ms),
        windowMs: window.ms,
        max: window.max,
      });
    }
  }
  return charges;
}

/** Seconds until the latest refusing window ends; at least 1. */
export function retryAfterSeconds(
  charges: readonly BucketCharge[],
  counts: readonly number[],
  at: Date,
): number {
  let until = at.getTime();
  charges.forEach((charge, index) => {
    if ((counts[index] ?? 0) > charge.max) {
      until = Math.max(until, charge.windowStart.getTime() + charge.windowMs);
    }
  });
  return Math.max(1, Math.ceil((until - at.getTime()) / 1_000));
}

/**
 * The in-process store: the fail-open fallback and the unit tests' double. Bounded like
 * `rate-limiter.ts` — at `maxKeys` the least recently touched bucket goes first.
 */
export function createMemoryBucketStore(options: { maxKeys?: number } = {}): BucketStore {
  const maxKeys = Math.max(1, options.maxKeys ?? 10_000);
  const buckets = new Map<string, { windowStart: number; count: number; touched: number }>();
  const current = (charge: BucketCharge): number => {
    const existing = buckets.get(charge.bucketKey);
    return existing && existing.windowStart === charge.windowStart.getTime() ? existing.count : 0;
  };
  return {
    chargeAll(charges, at) {
      const counts = charges.map((charge) => current(charge) + 1);
      const admitted = charges.every((charge, index) => (counts[index] ?? 0) <= charge.max);
      if (admitted) {
        charges.forEach((charge, index) => {
          buckets.delete(charge.bucketKey);
          if (buckets.size >= maxKeys) {
            const oldest = buckets.keys().next().value;
            if (oldest !== undefined) buckets.delete(oldest);
          }
          buckets.set(charge.bucketKey, {
            windowStart: charge.windowStart.getTime(),
            count: counts[index] ?? 1,
            touched: at.getTime(),
          });
        });
      }
      return Promise.resolve({ admitted, counts });
    },
    sweep(before, limit) {
      let removed = 0;
      for (const [key, bucket] of buckets) {
        if (removed >= limit) break;
        if (bucket.touched < before.getTime()) {
          buckets.delete(key);
          removed += 1;
        }
      }
      return Promise.resolve(removed);
    },
  };
}

export interface AnonymousCircuitBreakerOptions {
  /** Anonymous requests admitted per process per minute before anonymous routes degrade. */
  readonly maxPerMinute: number;
}

/**
 * The global breaker for anonymous endpoints (plan §56-05 "if the host is under attack, anonymous
 * endpoints degrade first, members keep working"). In process on purpose: a single global row
 * would serialise every anonymous request on one lock, and the point of the breaker is to refuse
 * before the database is asked anything.
 */
export function createAnonymousCircuitBreaker(options: AnonymousCircuitBreakerOptions): {
  admit(at: Date): { admitted: boolean; retryAfterSeconds: number };
} {
  const max = Math.max(1, options.maxPerMinute);
  let windowStart = 0;
  let count = 0;
  return {
    admit(at) {
      const start = windowStartFor(at, MINUTE_MS).getTime();
      if (start !== windowStart) {
        windowStart = start;
        count = 0;
      }
      count += 1;
      const retry = Math.max(1, Math.ceil((start + MINUTE_MS - at.getTime()) / 1_000));
      return { admitted: count <= max, retryAfterSeconds: retry };
    },
  };
}

export interface DurableRateLimiterOptions {
  readonly store: BucketStore;
  /** Server-side secret the daily pepper is derived from. Never logged. */
  readonly secret: string;
  /** Used when the store throws and the policy fails open. */
  readonly fallback?: BucketStore;
  readonly now?: () => Date;
  /** Sweep buckets untouched for this long, at most once per `sweepEveryMs`. Default 2 h / 1 h. */
  readonly retainMs?: number;
  readonly sweepEveryMs?: number;
  /** Called with the error when the store fails; the limiter itself never logs. */
  readonly onStoreError?: (error: unknown, policy: string) => void;
  /**
   * Multiplies every ceiling (default 1). Only for suites that sign in many times a minute from one
   * address (`RATE_LIMIT_SCALE` in e2e); production leaves it at 1.
   */
  readonly limitScale?: number;
}

export class DurableRateLimiter {
  private readonly fallback: BucketStore;
  private readonly now: () => Date;
  private readonly retainMs: number;
  private readonly sweepEveryMs: number;
  private readonly limitScale: number;
  private lastSweep = 0;

  constructor(private readonly options: DurableRateLimiterOptions) {
    this.fallback = options.fallback ?? createMemoryBucketStore();
    this.now = options.now ?? (() => new Date());
    this.retainMs = options.retainMs ?? 2 * HOUR_MS;
    this.sweepEveryMs = options.sweepEveryMs ?? HOUR_MS;
    this.limitScale =
      options.limitScale !== undefined && options.limitScale > 0 ? options.limitScale : 1;
  }

  async check(policy: ThrottlePolicy, subject: ThrottleSubject): Promise<ThrottleDecision> {
    const at = this.now();
    const charges = bucketsFor(policy, subject, at, dailyPepper(this.options.secret, at)).map(
      (charge) => ({ ...charge, max: Math.max(1, Math.floor(charge.max * this.limitScale)) }),
    );
    let result: BucketChargeResult;
    let degraded = false;
    try {
      result = await this.options.store.chargeAll(charges, at);
    } catch (error) {
      this.options.onStoreError?.(error, policy.name);
      if ((policy.onStoreError ?? 'closed') === 'closed') {
        return {
          admitted: false,
          reason: 'store_unavailable',
          retryAfterSeconds: STORE_UNAVAILABLE_RETRY_SECONDS,
        };
      }
      degraded = true;
      result = await this.fallback.chargeAll(charges, at);
    }
    if (!degraded) this.maybeSweep(at);
    if (result.admitted) return { admitted: true, degraded };
    return {
      admitted: false,
      reason: 'limit',
      retryAfterSeconds: retryAfterSeconds(charges, result.counts, at),
    };
  }

  /** Hourly, fire-and-forget: no cron is needed on the one Hostinger app. */
  private maybeSweep(at: Date): void {
    if (at.getTime() - this.lastSweep < this.sweepEveryMs) return;
    this.lastSweep = at.getTime();
    void this.options.store
      .sweep(new Date(at.getTime() - this.retainMs), 5_000)
      .catch((error: unknown) => this.options.onStoreError?.(error, 'sweep'));
  }
}
