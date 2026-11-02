import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { createFieldCipher, parseFieldCipherKeys } from '@tmanage/domain/field-cipher';
import { ApiError } from '../../common/http/errors.js';
import { WebhooksController } from './webhooks.controller.js';
import type { WebhooksRepository } from './webhooks.repository.js';
import type { WebhookDeliveriesRepository } from './webhook-deliveries.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WebhookEndpointRow } from '../../common/database/schema.js';

/** R13-s2 — secret once, rotation overlap, replay caps, resume behind the egress guard. */
const context = { organizationId: 'org-1', userId: 'user-1' } as unknown as TenantContext;
const owner = {
  userId: 'user-1',
  organizationId: 'org-1',
  kind: 'internal',
  role: 'owner',
  membershipId: 'm-1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
} as Principal;
const NOW = new Date('2026-11-02T12:00:00.000Z');
const cipher = createFieldCipher(parseFieldCipherKeys(`1:${'A'.repeat(43)}=`));
const db = {
  read: (_c: unknown, work: (r: never) => unknown) => work({} as never),
  transaction: (_c: unknown, work: (r: never) => unknown) => work({} as never),
} as unknown as TenantDatabase;

function harness(
  row: Partial<WebhookEndpointRow> = {},
  lastReplayAt: Date | null = null,
  events = 3,
) {
  const audits: { action: string; metadata: unknown }[] = [];
  const staged: unknown[] = [];
  let current = {
    id: 'wh-1',
    organizationId: 'org-1',
    url: 'https://hooks.example.com/x',
    eventKind: 'work.created',
    eventsJson: '["work.created"]',
    status: 'active',
    enabled: true,
    secretHash: 'a'.repeat(64),
    secretEnc: 'fc1.x',
    failureStreak: 0,
    createdBy: 'user-1',
    createdAt: NOW,
    ...row,
  } as WebhookEndpointRow;
  const repo = {
    findById: () => Promise.resolve(current),
    create: (_r: never, _c: never, input: Record<string, unknown>) =>
      Promise.resolve({ ...current, status: input['status'], secretEnc: input['secretEnc'] }),
    rotateSecret: (_r: never, _c: never, _id: string, input: Record<string, unknown>) => {
      current = { ...current, ...input, secretPrevExpiresAt: input['prevExpiresAt'] } as never;
      return Promise.resolve(current);
    },
    setStatus: (_r: never, _c: never, _id: string, status: string) =>
      Promise.resolve({ ...current, status }),
    listReplayableEvents: (_r: never, _c: never, _t: never, _f: never, _to: never, limit: number) =>
      Promise.resolve(
        Array.from({ length: Math.min(events, limit) }, (_, i) => ({
          id: `ev-${String(i)}`,
          type: 'work_item.created.v1',
          payload: {},
          occurredAt: NOW,
        })),
      ),
  } as unknown as WebhooksRepository;
  const audit = {
    append: (_r: never, _c: never, input: { action: string; metadata: unknown }) => {
      audits.push(input);
      return Promise.resolve({});
    },
    list: () => Promise.resolve(lastReplayAt ? [{ createdAt: lastReplayAt }] : []),
  };
  const deliveries = {
    stagePending: (_r: never, _c: never, rows: unknown[]) => (
      staged.push(...rows),
      Promise.resolve([])
    ),
  } as unknown as WebhookDeliveriesRepository;
  const resolve = (address: string) => () => Promise.resolve([{ address, family: 4 }]);
  const make = (address = '93.184.216.34', withCipher = cipher) =>
    new WebhooksController(db, repo, {
      cipher: withCipher,
      audit: audit as never,
      deliveries,
      now: () => NOW,
      egress: { ownHosts: [], resolve: resolve(address) },
    });
  return { make, audits, staged };
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => 0,
    (e: unknown) => (e instanceof ApiError ? e.status : -1),
  );

describe('webhooks v2 routes (R13-s2)', () => {
  it('returns a generated secret once on create; keyless creates needs_rotation with no secret', async () => {
    const body = { url: 'https://hooks.example.com/x', events: ['work.created', 'work.completed'] };
    const made = await harness().make().register(context, owner, body);
    expect(made.secret).toMatch(/^whsec_/u);
    expect(made.status).toBe('active');
    const keyless = await harness()
      .make(undefined, createFieldCipher(null))
      .register(context, owner, body);
    expect(keyless).toMatchObject({ secret: null, status: 'needs_rotation' });
  });

  it('rotates: new secret once, previous kept 24 h, audited with key ids only', async () => {
    const h = harness();
    const rotated = await h.make().rotateSecret(context, owner, 'wh-1');
    expect(rotated.secret).toMatch(/^whsec_/u);
    expect(rotated.previousSecretExpiresAt).toBe('2026-11-03T12:00:00.000Z');
    expect(h.audits[0]).toMatchObject({
      action: 'webhook.secret_rotated',
      metadata: { previous_key_id: 'aaaaaaaa' },
    });
    expect(JSON.stringify(h.audits)).not.toContain(rotated.secret as string);
  });

  it('caps replay: 7-day window, 10 000 events, once an hour', async () => {
    const from = '2026-11-01T00:00:00.000Z';
    const ok = harness();
    expect(await ok.make().replay(context, owner, 'wh-1', { from, to: NOW.toISOString() })).toEqual(
      { queued: 3 },
    );
    expect(ok.audits[0]?.action).toBe('webhook.replayed');
    const wide = harness()
      .make()
      .replay(context, owner, 'wh-1', { from: '2026-10-20T00:00:00Z', to: from });
    expect(await code(wide)).toBe(400);
    const many = harness({}, null, 10_001)
      .make()
      .replay(context, owner, 'wh-1', { from, to: NOW.toISOString() });
    expect(await code(many)).toBe(400);
    const recent = harness({}, new Date(NOW.getTime() - 30 * 60_000));
    expect(
      await code(recent.make().replay(context, owner, 'wh-1', { from, to: NOW.toISOString() })),
    ).toBe(429);
    expect(recent.staged).toHaveLength(0);
  });

  it('refuses to resume an endpoint whose host now resolves to 127.0.0.1', async () => {
    const h = harness({ status: 'paused' });
    expect(await code(h.make('127.0.0.1').resume(context, owner, 'wh-1'))).toBe(400);
    expect(h.audits).toHaveLength(0);
    expect((await h.make().resume(context, owner, 'wh-1')).status).toBe('active');
  });
});
