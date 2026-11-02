import { describe, expect, it } from 'vitest';
import { OUTBOX_EVENT_CATALOG } from '@tmanage/domain';
import { canonicalJson, signWebhook, verifyWebhookSignature } from './webhook-signing.js';
import { resolveEgress } from './egress-resolve.js';
import { WEBHOOK_EVENT_SOURCES, eventFiresKind, parseEventsJson } from './webhook-event-catalog.js';

/** The same vector is pinned in apps/worker/src/consumers/webhook-deliveries.test.ts. */
const VECTOR = 'v1=140baece2d31cd9d7f4bc0a5d29b9423ceee25ac7fb6d243468bd64e06541aca';
const BODY = canonicalJson({ b: 1, a: { d: 2, c: [3] } });

describe('webhook signing (R13-s2)', () => {
  it('signs the canonical body with HMAC-SHA256 over "<ts>.<body>" — the pinned vector', () => {
    expect(BODY).toBe('{"a":{"c":[3],"d":2},"b":1}');
    const headers = signWebhook({
      secret: 'whsec_test',
      timestamp: 1_700_000_000,
      body: BODY,
      deliveryId: 'd-1',
      eventKind: 'work.created',
      organizationId: 'org-1',
    });
    expect(headers['X-TManage-Signature']).toBe(VECTOR);
    expect(headers['X-TManage-Timestamp']).toBe('1700000000');
  });

  it('adds the previous secret during the overlap; a receiver on either secret verifies', () => {
    const headers = signWebhook({
      secret: 'whsec_new',
      previousSecret: 'whsec_old',
      timestamp: 1_700_000_000,
      body: BODY,
      deliveryId: 'd-1',
      eventKind: 'work.created',
      organizationId: 'org-1',
    });
    const header = headers['X-TManage-Signature'] as string;
    expect(header.split(',')).toHaveLength(2);
    for (const secret of ['whsec_new', 'whsec_old']) {
      const input = { secret, header, timestamp: 1_700_000_000, body: BODY };
      expect(verifyWebhookSignature({ ...input, nowSeconds: 1_700_000_010 })).toBe(true);
      expect(verifyWebhookSignature({ ...input, nowSeconds: 1_700_000_400 })).toBe(false);
    }
    expect(
      verifyWebhookSignature({
        secret: 'whsec_x',
        header,
        timestamp: 1_700_000_000,
        body: BODY,
        nowSeconds: 1_700_000_000,
      }),
    ).toBe(false);
  });
});

describe('webhook event filter (R13-s2)', () => {
  it('builds every kind from a live outbox event type', () => {
    for (const entry of Object.values(WEBHOOK_EVENT_SOURCES)) {
      expect(Object.hasOwn(OUTBOX_EVENT_CATALOG, entry.source)).toBe(true);
    }
  });

  it('fires work.completed only on toState done, and drops unknown kinds from events_json', () => {
    expect(eventFiresKind('work.completed', 'work_item.updated.v1', { toState: 'done' })).toBe(
      true,
    );
    expect(eventFiresKind('work.completed', 'work_item.updated.v1', { toState: 'review' })).toBe(
      false,
    );
    expect(eventFiresKind('work.updated', 'work_item.updated.v1', { toState: 'review' })).toBe(
      true,
    );
    expect(eventFiresKind('work.created', 'work_item.updated.v1', {})).toBe(false);
    expect(parseEventsJson('["work.created","nope","work.created"]')).toEqual(['work.created']);
  });
});

describe('delivery-time egress guard (R13-s2, SEC)', () => {
  const resolveTo = (address: string) => () => Promise.resolve([{ address, family: 4 }]);

  it('refuses a name that rebinds to 127.0.0.1 / metadata at delivery (blocked_private_ip)', async () => {
    for (const address of ['127.0.0.1', '169.254.169.254', '10.1.2.3', '::1']) {
      const verdict = await resolveEgress('https://hooks.example.com/x', {
        resolve: resolveTo(address),
      });
      expect(verdict).toEqual({ ok: false, reason: 'blocked_private_ip' });
    }
  });

  it('refuses a mixed answer, TManage itself and a dead name; pins a public address', async () => {
    const mixed = () =>
      Promise.resolve([
        { address: '93.184.216.34', family: 4 },
        { address: '192.168.1.1', family: 4 },
      ]);
    expect(await resolveEgress('https://a.example.com', { resolve: mixed })).toMatchObject({
      ok: false,
    });
    expect(
      await resolveEgress('https://api.tmanage.example/h', { ownHosts: ['tmanage.example'] }),
    ).toEqual({ ok: false, reason: 'blocked_own_host' });
    const dead = () => Promise.reject(new Error('ENOTFOUND'));
    expect(await resolveEgress('https://gone.example.com', { resolve: dead })).toEqual({
      ok: false,
      reason: 'unresolvable',
    });
    const ok = await resolveEgress('https://a.example.com', {
      resolve: resolveTo('93.184.216.34'),
    });
    expect(ok).toMatchObject({ ok: true, address: '93.184.216.34' });
  });
});
