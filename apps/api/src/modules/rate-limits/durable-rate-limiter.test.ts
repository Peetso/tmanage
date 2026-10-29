import { describe, expect, it } from 'vitest';
import {
  DurableRateLimiter,
  createAnonymousCircuitBreaker,
  createMemoryBucketStore,
  type BucketStore,
  type ThrottlePolicy,
  type ThrottleSubject,
} from './durable-rate-limiter.js';
import { OrgQuotaService, type QuotaCounterStore } from './org-quotas.js';
import type { TenantContext } from '../../common/database/tenant-context.js';

const T0 = Date.UTC(2026, 9, 29, 10, 0, 0);
const policy = (over: Partial<ThrottlePolicy> = {}): ThrottlePolicy => ({
  name: 'intake_submit',
  perMinute: 2,
  perHour: 3,
  key: 'ip',
  ...over,
});
const down = () => Promise.reject(new Error('db down'));
const failing: BucketStore = { chargeAll: down, sweep: down };

function limiter(store: BucketStore = createMemoryBucketStore()) {
  let now = T0;
  const instance = new DurableRateLimiter({ store, secret: 's', now: () => new Date(now) });
  const admits = async (p: ThrottlePolicy, subject: ThrottleSubject) =>
    (await instance.check(p, subject)).admitted;
  return { instance, admits, advance: (ms: number) => (now += ms) };
}

describe('DurableRateLimiter (56-05)', () => {
  it('admits up to the minute limit, refuses the next with Retry-After, resets on the next window', async () => {
    const { instance, admits, advance } = limiter();
    const p = policy({ perHour: 100 });
    expect(await admits(p, { ip: '1.1.1.1' })).toBe(true);
    advance(30_000);
    expect(await admits(p, { ip: '1.1.1.1' })).toBe(true);
    const refused = await instance.check(p, { ip: '1.1.1.1' });
    expect(refused).toEqual({ admitted: false, reason: 'limit', retryAfterSeconds: 30 });
    advance(30_000);
    expect(await admits(p, { ip: '1.1.1.1' })).toBe(true);
  });

  it('keeps keys and policies isolated', async () => {
    const { admits } = limiter();
    const p = policy({ perMinute: 1 });
    expect(await admits(p, { ip: '1.1.1.1' })).toBe(true);
    expect(await admits(p, { ip: '2.2.2.2' })).toBe(true);
    expect(await admits(policy({ name: 'other', perMinute: 1 }), { ip: '1.1.1.1' })).toBe(true);
    expect(await admits(p, { ip: '1.1.1.1' })).toBe(false);
  });

  it('is two-phase: a refusal by the minute window does not spend the hour window', async () => {
    const { admits, advance } = limiter();
    const p = policy({ perMinute: 1, perHour: 2 });
    expect(await admits(p, { ip: 'a' })).toBe(true);
    expect(await admits(p, { ip: 'a' })).toBe(false);
    advance(60_000); // had the refusals charged the hour, it would now be spent
    expect(await admits(p, { ip: 'a' })).toBe(true);
    advance(60_000);
    expect(await admits(p, { ip: 'a' })).toBe(false); // hour spent by the two admissions
  });

  it('ip+link charges both keys, and a missing link is still counted', async () => {
    const { admits } = limiter();
    const p = policy({ key: 'ip+link', perMinute: 1, perHour: 100 });
    expect(await admits(p, { ip: 'a', link: 'x' })).toBe(true);
    expect(await admits(p, { ip: 'b', link: 'x' })).toBe(false); // link spent
    expect(await admits(p, { ip: 'c' })).toBe(true);
    expect(await admits(p, { ip: 'd' })).toBe(false); // shared "none" link
  });

  it('fails closed by default and fails open to the in-process store when the policy says so', async () => {
    const { instance, admits } = limiter(failing);
    expect(await instance.check(policy(), { ip: 'a' })).toMatchObject({
      admitted: false,
      reason: 'store_unavailable',
    });
    const open = policy({ onStoreError: 'open', perMinute: 1 });
    expect(await instance.check(open, { ip: 'a' })).toEqual({ admitted: true, degraded: true });
    expect(await admits(open, { ip: 'a' })).toBe(false);
  });
});

describe('anonymous circuit breaker and org quotas', () => {
  it('opens past the per-minute ceiling and closes next minute', () => {
    const breaker = createAnonymousCircuitBreaker({ maxPerMinute: 1 });
    expect(breaker.admit(new Date(T0)).admitted).toBe(true);
    expect(breaker.admit(new Date(T0 + 1_000))).toEqual({ admitted: false, retryAfterSeconds: 59 });
    expect(breaker.admit(new Date(T0 + 60_000)).admitted).toBe(true);
  });

  it('refuses a quota over the plan limit with Retry-After to UTC midnight', async () => {
    let used = 1_999;
    const store: QuotaCounterStore = {
      charge: ({ amount, limit }) =>
        Promise.resolve(
          used + amount <= limit
            ? { admitted: true, used: (used += amount) }
            : { admitted: false, used },
        ),
    };
    const service = new OrgQuotaService(store, () => new Date(T0));
    const input = { context: {} as TenantContext, planId: 'free', metric: 'api_calls' } as const;
    expect(await service.consume(input)).toEqual({ admitted: true, used: 2_000, limit: 2_000 });
    expect(await service.consume(input)).toEqual({
      admitted: false,
      used: 2_000,
      limit: 2_000,
      retryAfterSeconds: 14 * 3_600,
    });
  });
});
