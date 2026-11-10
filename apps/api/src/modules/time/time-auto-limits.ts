import { ApiError } from '../../common/http/errors.js';
import type { ThrottlePolicy, ThrottleSubject } from '../rate-limits/durable-rate-limiter.js';

/**
 * FIX-2026-11-10 (security review L4) — the brakes on the automatic-tracking routes. The durable
 * limiter fails CLOSED for them (a store error refuses), and where no durable limiter is wired at
 * all, an in-process window takes its place: the brake is never simply off.
 */

export interface AutoLimiter {
  check(policy: ThrottlePolicy, subject: ThrottleSubject): Promise<{ readonly admitted: boolean }>;
}

/** Heartbeats: a minute's worth for two devices and a few changes. */
export const AUTO_HEARTBEAT_POLICY: ThrottlePolicy = {
  name: 'time_auto_heartbeat',
  perMinute: 12,
  key: 'link',
  onStoreError: 'closed',
};

/** "Working on now" changes (review M2): the same budget, its own bucket. */
export const AUTO_TASK_POLICY: ThrottlePolicy = {
  name: 'time_auto_task',
  perMinute: 12,
  key: 'link',
  onStoreError: 'closed',
};

const WINDOW_MS = 60_000;
/** The in-process window forgets the oldest keys past this many. */
const MAX_KEYS = 10_000;

/** A per-process sliding minute, for when no durable limiter is wired (tests, a bare boot). */
export class InProcessAutoLimiter implements AutoLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  check(policy: ThrottlePolicy, subject: ThrottleSubject): Promise<{ readonly admitted: boolean }> {
    const key = `${policy.name}:${subject.link ?? subject.ip ?? subject.token ?? ''}`;
    const at = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => at - t < WINDOW_MS);
    const admitted = recent.length < (policy.perMinute ?? Number.POSITIVE_INFINITY);
    if (admitted) recent.push(at);
    this.hits.delete(key);
    this.hits.set(key, recent);
    if (this.hits.size > MAX_KEYS) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    return Promise.resolve({ admitted });
  }
}

/** Charge one call of the caller against `policy`; a refusal is the usual 429. */
export async function chargeAuto(
  limiter: AutoLimiter,
  policy: ThrottlePolicy,
  organizationId: string,
  membershipId: string,
): Promise<void> {
  const decision = await limiter.check(policy, { link: `${organizationId}:${membershipId}` });
  if (!decision.admitted) {
    throw new ApiError(429, 'rate_limited', 'Too many tries. Please wait a minute.');
  }
}
