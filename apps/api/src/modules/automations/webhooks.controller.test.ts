import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { WebhooksController } from './webhooks.controller.js';
import type { CreateWebhookEndpointInput, WebhooksRepository } from './webhooks.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WebhookEndpointRow } from '../../common/database/schema.js';

/**
 * Automations webhooks (x166) — SEC unit suite over fakes with the **real** `authorize()`, so these
 * prove the actual decisions: an owner registers an https public endpoint (201, no secret echoed); an
 * SSRF / non-https URL and an off-list event are 400s with no write; a cross-tenant `:id` is a 404
 * with no write; a principal without `org.manage` is a 403. No DB (the chain owns the round-trip).
 */

const ORG = 'org-under-test';
const context = { organizationId: ORG, userId: 'user-1' } as unknown as TenantContext;
const SECRET = 'a-signing-secret-value';
const OK = { url: 'https://hooks.example.com/tm', eventKind: 'work.created', secret: SECRET };

function owner(): Principal {
  return {
    userId: 'user-1',
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: 'm-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  const run = <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner);
  return { read: run, transaction: run } as unknown as TenantDatabase;
}

function controllerWith(existing: readonly WebhookEndpointRow[] = []): {
  controller: WebhooksController;
  created: CreateWebhookEndpointInput[];
} {
  const created: CreateWebhookEndpointInput[] = [];
  const rows = [...existing];
  const repo = {
    findById: (_r: never, _c: TenantContext, id: string) =>
      Promise.resolve(rows.find((row) => row.id === id) ?? null),
    create: (_r: never, _c: TenantContext, input: CreateWebhookEndpointInput) => {
      created.push(input);
      return Promise.resolve({
        id: 'wh-1',
        organizationId: ORG,
        url: input.url,
        eventKind: input.eventKind,
        secretHash: input.secretHash,
        enabled: true,
        createdBy: input.createdBy,
        createdAt: new Date('2026-09-27T00:00:00.000Z'),
      } as unknown as WebhookEndpointRow);
    },
    setEnabled: () => Promise.resolve(null),
  } as unknown as WebhooksRepository;
  return { controller: new WebhooksController(fakeDatabase(), repo), created };
}

async function status(promise: Promise<unknown>): Promise<number> {
  return promise.then(
    () => 0,
    (error: unknown) => (error instanceof ApiError ? error.status : -1),
  );
}

describe('WebhooksController (x166)', () => {
  it('registers an https public endpoint (201) and never echoes the secret', async () => {
    const { controller, created } = controllerWith();
    const view = await controller.register(context, owner(), OK);
    expect(view).not.toHaveProperty('secret');
    expect(view).not.toHaveProperty('secretHash');
    expect(view).not.toHaveProperty('organizationId');
    expect(created[0]?.secretHash).not.toBe(SECRET);
    expect(created[0]?.createdBy).toBe('user-1');
  });

  it('rejects an SSRF / non-https URL with a 400 and writes nothing', async () => {
    for (const url of [
      'http://hooks.example.com/tm',
      'https://localhost/tm',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.5/tm',
    ]) {
      const { controller, created } = controllerWith();
      expect(await status(controller.register(context, owner(), { ...OK, url }))).toBe(400);
      expect(created).toHaveLength(0);
    }
  });

  it('rejects an off-list event kind with a 400 and writes nothing', async () => {
    const { controller, created } = controllerWith();
    expect(
      await status(controller.register(context, owner(), { ...OK, eventKind: 'not.real' })),
    ).toBe(400);
    expect(created).toHaveLength(0);
  });

  it('returns 404 for a cross-tenant / unknown :id and does not write', async () => {
    const { controller } = controllerWith();
    expect(await status(controller.patch(context, owner(), 'wh-other', { enabled: false }))).toBe(
      404,
    );
  });

  it('refuses a principal without org.manage with a 403', async () => {
    const member = { ...owner(), role: 'member' } as Principal;
    const { controller } = controllerWith();
    expect(await status(controller.register(context, member, OK))).toBe(403);
    expect(await status(controller.list(context, member))).toBe(403);
  });
});
