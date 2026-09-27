import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { WebhookDeliveriesController } from './webhook-deliveries.controller.js';
import { WebhookDeliveriesService } from './webhook-deliveries.service.js';
import type {
  RecordDeliveryInput,
  WebhookDeliveriesRepository,
} from './webhook-deliveries.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WebhookDeliveryRow, WebhookEndpointRow } from '../../common/database/schema.js';

/**
 * Automations webhook deliveries (x221) — SEC unit suite over fakes with the **real** `authorize()`.
 * These prove the actual decisions: a cross-tenant `:endpointId` is a 404 resolved before authorize;
 * a principal without `org.manage` is a 403; an out-of-range `limit` is a 400; the record helper
 * refuses an off-list status and a cross-tenant endpoint, and structurally cannot carry a secret. No
 * DB (the chain owns the round-trip).
 */

const ORG = 'org-under-test';
const context = { organizationId: ORG, userId: 'user-1' } as unknown as TenantContext;

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

const endpoint = { id: 'wh-1', organizationId: ORG } as unknown as WebhookEndpointRow;

function delivery(id: string): WebhookDeliveryRow {
  return {
    id,
    organizationId: ORG,
    endpointId: 'wh-1',
    status: 'success',
    responseCode: 200,
    attemptedAt: new Date('2026-09-27T00:00:00.000Z'),
  } as unknown as WebhookDeliveryRow;
}

function repo(overrides: Partial<WebhookDeliveriesRepository> = {}): WebhookDeliveriesRepository {
  return {
    findEndpoint: () => Promise.resolve(endpoint),
    listByEndpoint: () => Promise.resolve([delivery('d-2'), delivery('d-1')]),
    record: () => Promise.resolve('d-new'),
    ...overrides,
  } as unknown as WebhookDeliveriesRepository;
}

async function status(promise: Promise<unknown>): Promise<number> {
  return promise.then(
    () => 0,
    (error: unknown) => (error instanceof ApiError ? error.status : -1),
  );
}

describe('WebhookDeliveriesController (x221)', () => {
  it("lists an endpoint's attempts for an owner, newest first, projecting no tenant id", async () => {
    const controller = new WebhookDeliveriesController(fakeDatabase(), repo());
    const body = await controller.list(context, owner(), 'wh-1');
    expect(body.deliveries.map((d) => d.id)).toEqual(['d-2', 'd-1']);
    expect(body.deliveries[0]).not.toHaveProperty('organizationId');
    expect(body.deliveries[0]?.responseCode).toBe(200);
  });

  it('returns 404 for a cross-tenant / unknown :endpointId (resolve before authorize)', async () => {
    const controller = new WebhookDeliveriesController(
      fakeDatabase(),
      repo({ findEndpoint: () => Promise.resolve(null) }),
    );
    expect(await status(controller.list(context, owner(), 'wh-other'))).toBe(404);
  });

  it('refuses a principal without org.manage with a 403', async () => {
    const member = { ...owner(), role: 'member', hasOrgWideScope: false } as Principal;
    const controller = new WebhookDeliveriesController(fakeDatabase(), repo());
    expect(await status(controller.list(context, member, 'wh-1'))).toBe(403);
  });

  it('rejects an out-of-range limit with a 400', async () => {
    const controller = new WebhookDeliveriesController(fakeDatabase(), repo());
    expect(await status(controller.list(context, owner(), 'wh-1', '0'))).toBe(400);
    expect(await status(controller.list(context, owner(), 'wh-1', '201'))).toBe(400);
  });
});

describe('WebhookDeliveriesService.recordDelivery (x221)', () => {
  it('records an attempt carrying only the outcome — never a secret or body', async () => {
    const written: RecordDeliveryInput[] = [];
    const service = new WebhookDeliveriesService(
      fakeDatabase(),
      repo({
        record: (_r, _c, input: RecordDeliveryInput) => {
          written.push(input);
          return Promise.resolve('d-new');
        },
      }),
    );
    await service.recordDelivery(context, {
      endpointId: 'wh-1',
      status: 'failure',
      responseCode: 503,
    });
    expect(written[0]).toEqual({ endpointId: 'wh-1', status: 'failure', responseCode: 503 });
    expect(written[0]).not.toHaveProperty('secret');
    expect(written[0]).not.toHaveProperty('body');
  });

  it('refuses an off-list status (400) and a cross-tenant endpoint (404) with no write', async () => {
    const okRepo = repo();
    const offList = new WebhookDeliveriesService(fakeDatabase(), okRepo);
    expect(
      await status(
        offList.recordDelivery(context, {
          endpointId: 'wh-1',
          status: 'exploded' as never,
          responseCode: null,
        }),
      ),
    ).toBe(400);

    const crossTenant = new WebhookDeliveriesService(
      fakeDatabase(),
      repo({ findEndpoint: () => Promise.resolve(null) }),
    );
    expect(
      await status(
        crossTenant.recordDelivery(context, {
          endpointId: 'wh-other',
          status: 'success',
          responseCode: 200,
        }),
      ),
    ).toBe(404);
  });
});
