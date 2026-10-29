import { describe, expect, it } from 'vitest';
import type { MailMessage } from '@tmanage/mail';
import { createMemoryBucketStore } from '../rate-limits/durable-rate-limiter.js';
import { AbuseBuckets } from './abuse-buckets.js';
import { createMemoryAbuseStore } from './abuse-events.repository.js';
import { ChallengeService, OTP_BUDGET_ALERT_KIND, RESEND_AFTER_MS } from './challenge.service.js';
import { solvePow } from './pow.js';
import type { FetchLike } from './turnstile.js';

/**
 * UNIT-52-25 / SEC-52-20 — the e-mail code (hashed, single use, 5 attempts, resend after 60 s),
 * proof-of-work, the OTP budget alert, and Turnstile failing open to the e-mail code.
 */

function harness(options: { fetchImpl?: FetchLike; budgetScale?: number } = {}) {
  let now = new Date('2026-10-29T10:00:00.000Z');
  const sent: MailMessage[] = [];
  const alerts: string[] = [];
  const store = createMemoryAbuseStore();
  const buckets = new AbuseBuckets({
    store: createMemoryBucketStore(),
    secret: 'pepper',
    now: () => now,
    ...(options.budgetScale === undefined ? {} : { limitScale: options.budgetScale }),
  });
  let nextCode = 1234;
  const service = new ChallengeService({
    store,
    buckets,
    secret: 'challenge-secret',
    mailer: {
      send: async (message) => {
        sent.push(message);
        return 'sent';
      },
    },
    alerts: {
      notify: async (kind) => {
        alerts.push(kind);
      },
    },
    turnstileSecret: async () => 'turnstile-secret',
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    now: () => now,
    randomCode: () => String(nextCode++),
  });
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  return { service, store, sent, alerts, advance };
}

const correlationId = 'c-1';

describe('the e-mail code', () => {
  it('is mailed, stored only as a hash, and solves once', async () => {
    const { service, sent } = harness();
    const issued = await service.issueEmailCode({
      email: 'Ada@Example.com',
      ip: '1.2.3.4',
      correlationId,
    });
    if (!issued.ok) throw new Error('expected an issue');
    expect(issued.challenge).toMatchObject({ kind: 'email_code', resendAfterSeconds: 60 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('ada@example.com');
    expect(sent[0]?.text).toContain('1234');

    const answer = { challengeId: issued.challenge.challengeId, ip: '1.2.3.4', correlationId };
    expect(await service.answer({ ...answer, code: '9999' })).toBe('wrong');
    expect(await service.answer({ ...answer, code: '1234' })).toBe('solved');
    expect(await service.answer({ ...answer, code: '1234' })).toBe('expired');
  });

  it('locks after five attempts and expires after ten minutes', async () => {
    const { service, advance } = harness();
    const first = await service.issueEmailCode({
      email: 'a@example.com',
      ip: '1.2.3.4',
      correlationId,
    });
    if (!first.ok) throw new Error('expected an issue');
    const answer = { challengeId: first.challenge.challengeId, ip: '9.9.9.9', correlationId };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await service.answer({ ...answer, code: '0000' })).toBe('wrong');
    }
    expect(await service.answer({ ...answer, code: '0000' })).toBe('locked');

    advance(RESEND_AFTER_MS);
    const second = await service.issueEmailCode({
      email: 'a@example.com',
      ip: '1.2.3.4',
      correlationId,
    });
    if (!second.ok) throw new Error('expected an issue');
    advance(10 * 60 * 1_000 + 1);
    expect(
      await service.answer({
        challengeId: second.challenge.challengeId,
        code: '1235',
        ip: '5.5.5.5',
        correlationId,
      }),
    ).toBe('expired');
  });

  it('does not resend within 60 s, and limits sends per address', async () => {
    const { service, sent, advance } = harness();
    const input = { email: 'b@example.com', ip: '1.2.3.4', correlationId };
    const first = await service.issueEmailCode(input);
    const again = await service.issueEmailCode(input);
    expect(sent).toHaveLength(1);
    if (!first.ok || !again.ok) throw new Error('expected issues');
    expect(again.challenge.challengeId).toBe(first.challenge.challengeId);
    advance(RESEND_AFTER_MS);
    await service.issueEmailCode(input);
    advance(RESEND_AFTER_MS);
    await service.issueEmailCode(input);
    advance(RESEND_AFTER_MS);
    expect(await service.issueEmailCode(input)).toMatchObject({
      ok: false,
      reason: 'rate_limited',
    });
  });
});

describe('proof-of-work', () => {
  it('issues a salt and difficulty and accepts a solution once', async () => {
    const { service } = harness();
    const issued = await service.issuePow({ correlationId });
    if (!issued.ok || issued.challenge.salt === undefined) throw new Error('expected a pow');
    expect(issued.challenge.bits).toBe(18);
    const solution = solvePow(issued.challenge.salt, issued.challenge.bits ?? 18);
    const answer = { challengeId: issued.challenge.challengeId, ip: '1.2.3.4', correlationId };
    expect(await service.answer({ ...answer, powSolution: 'x' })).toBe('wrong');
    expect(await service.answer({ ...answer, powSolution: solution })).toBe('solved');
  });
});

describe('SEC-52-20: a Turnstile outage falls back to the e-mail code within 3 s', () => {
  it('issues an e-mail code when siteverify never answers', async () => {
    const silent: FetchLike = () => new Promise(() => undefined);
    const { service, sent } = harness({ fetchImpl: silent });
    const started = Date.now();
    const result = await service.verifyTurnstileOrFallback({
      token: 'widget-token',
      ip: '1.2.3.4',
      email: 'c@example.com',
      correlationId,
    });
    expect(Date.now() - started).toBeLessThan(3_500);
    expect(result).toMatchObject({ outcome: 'fallback', issue: { ok: true } });
    expect(sent).toHaveLength(1);
  }, 6_000);
});

describe('the OTP budget', () => {
  it('raises otp_budget:80pct exactly once in the hour', async () => {
    // 300 / h scaled to 0.05 → a ceiling of 15; the alert is at 12.
    const { service, alerts } = harness({ budgetScale: 0.05 });
    for (let index = 0; index < 14; index += 1) {
      await service.issueEmailCode({
        email: `p${index}@example.com`,
        ip: `10.0.0.${index}`,
        correlationId,
      });
    }
    await Promise.resolve();
    expect(alerts).toEqual([OTP_BUDGET_ALERT_KIND]);
  });
});
