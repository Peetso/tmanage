import { describe, expect, it } from 'vitest';
import type { FieldCipher } from '@tmanage/domain/field-cipher';
import {
  WEBHOOK_SOURCES,
  canonicalJson,
  deliverAttempt,
  pickDue,
  signatureFor,
} from './webhook-deliveries.js';
import type { OpenAttempt, WebhookDeliveryStore, AttemptSettlement } from './webhook-deliveries.js';
import { decideAfterAttempt, nextAttemptDelayMs } from '../jobs/webhook-retry-sweeper.js';

/** R13-s2. The vector and the kind table are pinned in the API suite too (mirrors). */
const NOW = new Date('2026-11-02T12:00:00.000Z');
const attempt = (over: Partial<OpenAttempt> = {}): OpenAttempt => ({
  id: 'd-1',
  endpointId: 'wh-1',
  eventId: 'ev-1',
  eventKind: 'work.created',
  status: 'pending',
  attempt: 1,
  attemptedAt: NOW,
  nextAttemptAt: NOW,
  ...over,
});
const cipher = { decrypt: (envelope: string) => `plain-${envelope}` } as unknown as FieldCipher;

function store(prevExpires: Date | null = null) {
  const finished: AttemptSettlement[] = [];
  const s: WebhookDeliveryStore = {
    listActiveOrganizations: () => Promise.resolve([]),
    listOpenAttempts: () => Promise.resolve([]),
    reopen: () => Promise.resolve(),
    claim: () => Promise.resolve(true),
    loadEndpoint: () =>
      Promise.resolve({
        id: 'wh-1',
        url: 'https://hooks.example.com/x',
        status: 'active',
        enabled: true,
        secretHash: 'abcdef0123'.padEnd(64, '0'),
        secretEnc: 'new',
        secretPrevEnc: 'old',
        secretPrevExpiresAt: prevExpires,
      }),
    loadEvent: () =>
      Promise.resolve({
        type: 'work_item.created.v1',
        payload: { workItemId: 'w', title: 'secret' },
        occurredAt: NOW,
      }),
    finish: (_o, _a, settlement) => (finished.push(settlement), Promise.resolve({ kind: 'none' })),
  };
  return { s, finished };
}

describe('webhook delivery (R13-s2)', () => {
  it('mirrors the API signature vector and kind table', () => {
    expect(
      signatureFor('whsec_test', 1_700_000_000, canonicalJson({ b: 1, a: { d: 2, c: [3] } })),
    ).toBe('v1=140baece2d31cd9d7f4bc0a5d29b9423ceee25ac7fb6d243468bd64e06541aca');
    expect(Object.entries(WEBHOOK_SOURCES).map(([k, v]) => `${k}>${v.source}`)).toEqual([
      'work.created>work_item.created.v1',
      'work.updated>work_item.updated.v1',
      'work.completed>work_item.updated.v1',
      'approval.decided>approval.decided.v1',
      'document.published>document.published.v1',
      'client_request.created>client_request.submitted.v1',
      'client_request.transitioned>client_request.transitioned.v1',
      'meeting.scheduled>meeting.scheduled.v1',
    ]);
  });

  it('SEC: a host that rebinds to 127.0.0.1 at delivery is blocked_private_ip and never POSTed', async () => {
    const { s, finished } = store();
    let posted = false;
    const result = await deliverAttempt(
      {
        store: s,
        cipher,
        ownHosts: [],
        now: () => NOW,
        resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
        post: () => ((posted = true), Promise.resolve({ statusCode: 200, body: '' })),
      },
      'org-1',
      attempt(),
    );
    expect(result.status).toBe('blocked_private_ip');
    expect(posted).toBe(false);
    expect(finished[0]?.status).toBe('blocked_private_ip');
  });

  it('signs with both secrets during the overlap, pins the address, sends ids only', async () => {
    const { s, finished } = store(new Date(NOW.getTime() + 1000));
    let seen: { address: string; headers: Record<string, string>; body: string } | null = null;
    await deliverAttempt(
      {
        store: s,
        cipher,
        ownHosts: [],
        now: () => NOW,
        resolve: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
        post: (_u, address, headers, body) => (
          (seen = { address, headers: { ...headers }, body }),
          Promise.resolve({ statusCode: 204, body: '' })
        ),
      },
      'org-1',
      attempt(),
    );
    expect(seen!.address).toBe('93.184.216.34');
    expect(seen!.headers['X-TManage-Signature']?.split(',')).toHaveLength(2);
    expect(seen!.body).not.toContain('secret');
    expect(finished[0]).toMatchObject({
      status: 'success',
      signatureKeyId: 'abcdef01',
      resolvedIp: '93.184.216.34',
    });
  });

  it('backs off 1 m, 5 m, 30 m, 2 h, 8 h, then gives up; pauses at 20 failures or on 410', () => {
    expect([1, 2, 3, 4, 5, 6].map(nextAttemptDelayMs)).toEqual([
      60_000,
      300_000,
      1_800_000,
      7_200_000,
      28_800_000,
      null,
    ]);
    const fail = { status: 'failure' as const, responseCode: 500 };
    expect(decideAfterAttempt(fail, 2, 3)).toEqual({ kind: 'retry', delayMs: 300_000 });
    expect(decideAfterAttempt(fail, 6, 6)).toEqual({ kind: 'give_up' });
    expect(decideAfterAttempt(fail, 1, 19).kind).toBe('retry');
    expect(decideAfterAttempt(fail, 1, 20)).toEqual({
      kind: 'pause',
      reason: 'breaker_20_failures',
    });
    expect(decideAfterAttempt({ status: 'failure', responseCode: 410 }, 1, 1)).toEqual({
      kind: 'pause',
      reason: 'gone_410',
    });
    expect(decideAfterAttempt({ status: 'success', responseCode: 200 }, 3, 0)).toEqual({
      kind: 'reset',
    });
    expect(decideAfterAttempt({ status: 'failed_permanent', responseCode: null }, 1, 0)).toEqual({
      kind: 'none',
    });
  });

  it('runs one attempt per endpoint at a time and reopens a crashed sending row', () => {
    const { due, stale } = pickDue(
      [
        attempt({ id: 'a', endpointId: 'e1' }),
        attempt({ id: 'b', endpointId: 'e1' }),
        attempt({ id: 'c', endpointId: 'e2', status: 'sending' }),
        attempt({ id: 'd', endpointId: 'e2' }),
        attempt({
          id: 'e',
          endpointId: 'e3',
          status: 'sending',
          attemptedAt: new Date(NOW.getTime() - 600_000),
        }),
      ],
      NOW,
    );
    expect(due.map((row) => row.id)).toEqual(['a']);
    expect(stale.map((row) => row.id)).toEqual(['e']);
  });
});
