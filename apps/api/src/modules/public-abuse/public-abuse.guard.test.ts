import { describe, expect, it } from 'vitest';
import { createMemoryBucketStore } from '../rate-limits/durable-rate-limiter.js';
import { AbuseBuckets } from './abuse-buckets.js';
import { createMemoryAbuseStore } from './abuse-events.repository.js';
import { ChallengeService } from './challenge.service.js';
import { expectedJsProof, formProofKey, issueFormProof } from './form-proof.js';
import { PublicAbuseGuard } from './public-abuse.guard.js';
import type { PublicWriteRequest } from './public-abuse.guard.js';

/**
 * `assessPublicWrite`: block rules → windows → challenge answer → score, one telemetry row per
 * call (no content), SEC-52-18's scripted POST held, and a clean submission never challenged.
 */

const proofKey = formProofKey('session-secret');

function harness(blocked: { kind: 'email' | 'domain' | 'ip' } | null = null) {
  let now = new Date('2026-10-29T10:00:00.000Z');
  const store = createMemoryAbuseStore();
  const buckets = new AbuseBuckets({
    store: createMemoryBucketStore(),
    secret: 'pepper',
    now: () => now,
  });
  const challenges = new ChallengeService({
    store,
    buckets,
    secret: 'pepper',
    mailer: null,
    now: () => now,
    randomCode: () => '4321',
  });
  const guard = new PublicAbuseGuard({
    buckets,
    events: store,
    challenges,
    blockRules: async () => blocked,
    formProofKey: proofKey,
    secret: 'pepper',
    now: () => now,
  });
  return {
    guard,
    store,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    now: () => now,
  };
}

function humanBody(shownAt: Date): Record<string, unknown> {
  const { startedAt, nonce } = issueFormProof(proofKey, shownAt);
  return { startedAt, nonce, proof: expectedJsProof(nonce, startedAt), website: '' };
}

const request = (body: Record<string, unknown>, extra: Partial<PublicWriteRequest> = {}) => ({
  surface: 'contact',
  kind: 'contact' as const,
  body,
  email: 'ada@studio.example',
  texts: ['Ada', 'We would like a demo.'],
  ip: '203.0.113.7',
  correlationId: 'c-1',
  ...extra,
});

describe('assessPublicWrite', () => {
  it('allows a clean human submission and never challenges it', async () => {
    const { guard, store, advance, now } = harness();
    const body = humanBody(now());
    advance(9_000);
    const verdict = await guard.assess(request(body, { offerChallenge: true }));
    expect(verdict).toMatchObject({ decision: 'allow', score: 0 });
    expect(verdict.challenge).toBeUndefined();
    expect(store.events).toHaveLength(1);
    // No content in the row: a hash and a truncated address.
    expect(store.events[0]).toMatchObject({ decision: 'allow', ip: '203.0.113.0/24' });
    expect(JSON.stringify(store.events[0])).not.toContain('demo');
    expect(store.events[0]?.keyHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('SEC-52-18: a scripted POST without the JS proof scores at least 60 and is held', async () => {
    const { guard } = harness();
    const verdict = await guard.assess(request({}));
    expect(verdict.score).toBeGreaterThanOrEqual(60);
    expect(verdict.decision).toBe('hold');
    expect(verdict.reasons).toContain('no_js_proof');
  });

  it('offers a challenge on a held submission and allows the re-POST that answers it', async () => {
    const { guard } = harness();
    const held = await guard.assess(request({}, { offerChallenge: true }));
    expect(held.decision).toBe('challenge');
    expect(held.challenge).toMatchObject({ kind: 'email_code', resendAfterSeconds: 60 });
    const answered = await guard.assess(
      request({ challengeId: held.challenge?.challengeId, code: '4321' }, { offerChallenge: true }),
    );
    expect(answered.decision).toBe('allow');
  });

  it('blocks on an organization block rule and records a blocked event', async () => {
    const { guard, store } = harness({ kind: 'domain' });
    const verdict = await guard.assess(request({}, { orgId: 'org-1' }));
    expect(verdict).toMatchObject({ decision: 'blocked', reasons: ['block_rule:domain'] });
    expect(verdict.retryAfterSeconds).toBeUndefined();
    expect(store.events[0]).toMatchObject({ decision: 'blocked', organizationId: 'org-1' });
  });

  it('refuses the sixth form from one address in ten minutes with a retry time', async () => {
    const { guard } = harness();
    for (let index = 0; index < 5; index += 1) {
      expect((await guard.assess(request({}, { texts: [`m${index}`] }))).decision).not.toBe(
        'blocked',
      );
    }
    const sixth = await guard.assess(request({}));
    expect(sixth.decision).toBe('blocked');
    expect(sixth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('adds the 24 h repeat signal for the same values', async () => {
    const { guard, advance, now } = harness();
    advance(1);
    const firstBody = humanBody(now());
    advance(9_000);
    await guard.assess(request(firstBody));
    const secondBody = humanBody(now());
    advance(9_000);
    const second = await guard.assess(request(secondBody));
    expect(second.reasons).toEqual(['repeated_values']);
    expect(second.decision).toBe('hold');
  });
});
