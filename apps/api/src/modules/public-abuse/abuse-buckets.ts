import {
  HOUR_MS,
  MINUTE_MS,
  createMemoryBucketStore,
  dailyPepper,
  hashSubject,
  retryAfterSeconds,
  windowStartFor,
} from '../rate-limits/durable-rate-limiter.js';
import type { BucketCharge, BucketStore } from '../rate-limits/durable-rate-limiter.js';

/**
 * 52-21 — the abuse engine's windows, kept in 56-05's `rate_limit_buckets` (no second window
 * table, per 56-05's note). The route-level `@Throttle` budgets stay as they are; these are the
 * finer, per-purpose ceilings the spec names, with windows the route limiter does not have
 * (10 minutes, a UTC day). Keys are hashed with the same daily pepper as every other bucket.
 *
 * Day windows outlive the limiter's default two-hour sweep only because `RateLimitsModule` keeps
 * buckets for 26 h (still inside 56-05's "kept ≤ 48 h" privacy rule).
 */

export const DAY_MS = 24 * HOUR_MS;
const TEN_MINUTES_MS = 10 * MINUTE_MS;

export interface AbuseWindow {
  readonly label: string;
  readonly ms: number;
  readonly max: number;
}

export const PUBLIC_ABUSE_BUCKETS = {
  /** Every public form, per IP. The day count also feeds the "IP over 10/day" signal. */
  pub_form_ip: [
    { label: '10m', ms: TEN_MINUTES_MS, max: 5 },
    { label: 'd', ms: DAY_MS, max: 20 },
  ],
  /** One organization's public form (52-20), all callers together. */
  pub_form_slug: [{ label: 'd', ms: DAY_MS, max: 200 }],
  pub_otp_email: [{ label: '10m', ms: TEN_MINUTES_MS, max: 3 }],
  pub_otp_ip: [{ label: 'h', ms: HOUR_MS, max: 10 }],
  pub_otp_verify_token: [{ label: '10m', ms: TEN_MINUTES_MS, max: 5 }],
  /** For 56-07's public links and 52-18's quotes, which charge them from their own routes. */
  pub_token_open_ip: [{ label: 'm', ms: MINUTE_MS, max: 30 }],
  pub_verify_ip: [{ label: 'm', ms: MINUTE_MS, max: 10 }],
  pub_quote_accept_ip: [{ label: 'h', ms: HOUR_MS, max: 5 }],
  /** Every e-mail code the platform sends in an hour; 80 % raises `otp_budget:80pct` once. */
  pub_otp_budget_hour: [{ label: 'h', ms: HOUR_MS, max: 300 }],
  /** Proof-of-work challenges issued per minute, platform-wide: the adaptive difficulty's input. */
  pub_pow_minute: [{ label: 'm', ms: MINUTE_MS, max: 1_000_000 }],
} as const satisfies Record<string, readonly AbuseWindow[]>;

export type AbuseBucketName = keyof typeof PUBLIC_ABUSE_BUCKETS;

export interface AbuseBucketAsk {
  readonly name: AbuseBucketName;
  /** The raw key (an address, an e-mail, a challenge id, `all`); hashed before it is stored. */
  readonly raw: string;
}

export type AbuseChargeResult =
  | {
      readonly admitted: true;
      /** The count each window now holds, `name:label` → count. */
      readonly counts: ReadonlyMap<string, number>;
    }
  | {
      readonly admitted: false;
      readonly refused: readonly AbuseBucketName[];
      readonly retryAfterSeconds: number;
    };

export interface AbuseBucketsOptions {
  readonly store: BucketStore;
  readonly secret: string;
  /** `RATE_LIMIT_SCALE` (e2e only): multiplies every ceiling. */
  readonly limitScale?: number;
  readonly now?: () => Date;
}

export class AbuseBuckets {
  private readonly fallback = createMemoryBucketStore();
  private readonly now: () => Date;
  readonly limitScale: number;

  constructor(private readonly options: AbuseBucketsOptions) {
    this.now = options.now ?? (() => new Date());
    this.limitScale =
      options.limitScale !== undefined && options.limitScale > 0 ? options.limitScale : 1;
  }

  /** The scaled ceiling of one window. */
  max(name: AbuseBucketName, label: string): number {
    const window = (PUBLIC_ABUSE_BUCKETS[name] as readonly AbuseWindow[]).find(
      (entry) => entry.label === label,
    );
    return Math.max(1, Math.floor((window?.max ?? 1) * this.limitScale));
  }

  /** Ask and charge every window of every ask as one unit (56-05's two-phase rule). */
  async charge(asks: readonly AbuseBucketAsk[]): Promise<AbuseChargeResult> {
    const at = this.now();
    const pepper = dailyPepper(this.options.secret, at);
    const charges: (BucketCharge & { readonly id: string; readonly name: AbuseBucketName })[] = [];
    for (const ask of asks) {
      const hashed = hashSubject(pepper, ask.name, ask.raw === '' ? 'none' : ask.raw);
      for (const window of PUBLIC_ABUSE_BUCKETS[ask.name] as readonly AbuseWindow[]) {
        charges.push({
          id: `${ask.name}:${window.label}`,
          name: ask.name,
          bucketKey: `${ask.name}:${window.label}:${hashed}`,
          windowStart: windowStartFor(at, window.ms),
          windowMs: window.ms,
          max: this.max(ask.name, window.label),
        });
      }
    }
    let result;
    try {
      result = await this.options.store.chargeAll(charges, at);
    } catch {
      // The route-level budgets (56-05) already failed closed where that matters; the finer
      // windows degrade to this process rather than refusing every form during an outage.
      result = await this.fallback.chargeAll(charges, at);
    }
    if (result.admitted) {
      return {
        admitted: true,
        counts: new Map(charges.map((charge, index) => [charge.id, result.counts[index] ?? 1])),
      };
    }
    const refused = [
      ...new Set(
        charges
          .filter((charge, index) => (result.counts[index] ?? 0) > charge.max)
          .map((charge) => charge.name),
      ),
    ];
    return {
      admitted: false,
      refused,
      retryAfterSeconds: retryAfterSeconds(charges, result.counts, at),
    };
  }
}
