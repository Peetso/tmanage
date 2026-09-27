import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { InsightSavedViewsController } from './saved-views.controller.js';
import type { InsightSavedViewsService, InsightSavedViewInput } from './saved-views.service.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { InsightSavedViewRow } from '../../common/database/schema.js';

/**
 * INS saved views (x210) — the HTTP surface over a fake service, always the caller's own: create
 * persists and reads back, an unknown report kind or empty name is a 400 with no write, a delete the
 * store does not remove for this owner (another user's, or none) is a 404, and all three routes sit
 * behind `work.read` (a caller without it is refused 403 by `CapabilityGuard`).
 */

const ME = '00000000-0000-4000-8000-0000000000c1';
const context = { organizationId: 'org', userId: ME } as unknown as TenantContext;
const principal = { userId: ME } as unknown as Principal;

/** In-memory store keyed by id, scoped to the acting user, so a save is visible to its read-back. */
class FakeService {
  readonly rows = new Map<string, InsightSavedViewRow>();
  private n = 0;
  denyDelete = false;

  create(_c: TenantContext, input: InsightSavedViewInput): Promise<InsightSavedViewRow> {
    const id = `00000000-0000-7000-8000-00000000000${++this.n}`;
    const row = {
      id,
      organizationId: 'org',
      ownerUserId: ME,
      name: input.name,
      reportKind: input.reportKind,
      filters: input.filters,
      createdAt: new Date('2026-09-27T00:00:00.000Z'),
    } as unknown as InsightSavedViewRow;
    this.rows.set(id, row);
    return Promise.resolve(row);
  }
  listOwn(): Promise<InsightSavedViewRow[]> {
    return Promise.resolve([...this.rows.values()]);
  }
  deleteOwn(_c: TenantContext, id: string): Promise<boolean> {
    return Promise.resolve(this.denyDelete ? false : this.rows.delete(id));
  }
}

function controllerWith(service: FakeService): InsightSavedViewsController {
  return new InsightSavedViewsController(service as unknown as InsightSavedViewsService);
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('InsightSavedViewsController (x210)', () => {
  it('creates a view, lists it, then deletes it — always the caller’s own', async () => {
    const service = new FakeService();
    const controller = controllerWith(service);

    const created = await controller.create(context, principal, {
      name: 'My delivery view',
      reportKind: 'delivery-flow',
      filters: { projectId: 'p1' },
    });
    expect(created.ownerUserId).toBe(ME);
    expect(created.reportKind).toBe('delivery-flow');
    expect(created.filters).toEqual({ projectId: 'p1' });

    expect((await controller.list(context, principal)).savedViews).toHaveLength(1);
    expect((await controller.remove(context, principal, created.id)).savedViews).toHaveLength(0);
  });

  it('400s an unknown report kind, and 400s an empty name — writing nothing', async () => {
    const service = new FakeService();
    const bad = (body: unknown) =>
      controllerWith(service).create(
        context,
        principal,
        body as Parameters<InsightSavedViewsController['create']>[2],
      );
    await expectStatus(bad({ name: 'ok', reportKind: 'not-a-report', filters: {} }), 400);
    await expectStatus(bad({ name: '  ', reportKind: 'portfolio', filters: {} }), 400);
    expect(service.rows.size).toBe(0);
  });

  it('404s a delete of a view the store does not remove for this owner (other user’s / absent)', async () => {
    const service = new FakeService();
    service.denyDelete = true;
    await expectStatus(controllerWith(service).remove(context, principal, 'x'), 404);
  });

  it('guards all three routes with work.read (403 by CapabilityGuard for a caller without it)', () => {
    for (const method of ['list', 'create', 'remove'] as const) {
      expect(
        Reflect.getMetadata(REQUIRED_CAPABILITY, InsightSavedViewsController.prototype[method]),
      ).toBe('work.read');
    }
  });
});
