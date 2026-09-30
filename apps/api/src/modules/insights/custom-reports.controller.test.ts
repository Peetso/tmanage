import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { InsightCustomReportsController } from './custom-reports.controller.js';
import type {
  InsightCustomReportInput,
  InsightCustomReportsService,
  RenderedMetric,
} from './custom-reports.service.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { InsightCustomReportRow } from '../../common/database/schema.js';

/**
 * INS custom reports (x320) — the HTTP surface over a fake service, always the caller's own: create
 * persists and reads back, an off-allowlist metric key or empty name is a 400 with no write, and a
 * read/replace/delete of a report the store does not resolve for this owner (another member's, or
 * none) is a 404 — a private report's existence is not the caller's to learn. Every route sits behind
 * `work.read` (a caller without it is refused 403 by `CapabilityGuard`, so create never inserts).
 */

const ME = '00000000-0000-4000-8000-0000000000c1';
const context = { organizationId: 'org', userId: ME } as unknown as TenantContext;
const principal = { userId: ME } as unknown as Principal;

/** In-memory store keyed by id, scoped to the acting user, so a save is visible to its read-back. */
class FakeService {
  readonly rows = new Map<string, InsightCustomReportRow>();
  private n = 0;
  ownsNothing = false;

  create(_c: TenantContext, input: InsightCustomReportInput): Promise<InsightCustomReportRow> {
    const id = `00000000-0000-7000-8000-00000000000${++this.n}`;
    const row = {
      id,
      organizationId: 'org',
      ownerUserId: ME,
      name: input.name,
      metricKeys: input.metricKeys,
      layout: input.layout,
      createdAt: new Date('2026-09-27T00:00:00.000Z'),
      updatedAt: new Date('2026-09-27T00:00:00.000Z'),
    } as unknown as InsightCustomReportRow;
    this.rows.set(id, row);
    return Promise.resolve(row);
  }
  listOwn(): Promise<InsightCustomReportRow[]> {
    return Promise.resolve([...this.rows.values()]);
  }
  findOwn(_c: TenantContext, id: string): Promise<InsightCustomReportRow | null> {
    return Promise.resolve(this.ownsNothing ? null : (this.rows.get(id) ?? null));
  }
  render(): Promise<readonly RenderedMetric[]> {
    return Promise.resolve([{ metric: 'open_items', value: 3 }]);
  }
  replaceOwn(
    _c: TenantContext,
    id: string,
    input: InsightCustomReportInput,
  ): Promise<InsightCustomReportRow | null> {
    const row = this.rows.get(id);
    if (this.ownsNothing || !row) return Promise.resolve(null);
    const next = { ...row, ...input } as unknown as InsightCustomReportRow;
    this.rows.set(id, next);
    return Promise.resolve(next);
  }
  deleteOwn(_c: TenantContext, id: string): Promise<boolean> {
    return Promise.resolve(this.ownsNothing ? false : this.rows.delete(id));
  }
}

function controllerWith(service: FakeService): InsightCustomReportsController {
  return new InsightCustomReportsController(service as unknown as InsightCustomReportsService);
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

const good: InsightCustomReportInput = {
  name: 'My mix',
  metricKeys: ['open_items', 'active_projects'],
  layout: 'grid',
};

describe('InsightCustomReportsController (x320)', () => {
  it('creates a report, lists it, renders it, replaces it, then deletes it — always the caller’s own', async () => {
    const service = new FakeService();
    const controller = controllerWith(service);

    const created = await controller.create(context, principal, good);
    expect(created.ownerUserId).toBe(ME);
    expect(created.metricKeys).toEqual(['open_items', 'active_projects']);
    expect(created.layout).toBe('grid');

    expect((await controller.list(context, principal)).reports).toHaveLength(1);

    const rendered = await controller.getById(context, principal, created.id);
    expect(rendered.report.id).toBe(created.id);
    expect(rendered.metrics).toEqual([{ metric: 'open_items', value: 3 }]);

    const replaced = await controller.replace(context, principal, created.id, {
      ...good,
      name: 'Renamed',
    });
    expect(replaced.name).toBe('Renamed');

    await expect(controller.remove(context, principal, created.id)).resolves.toBeUndefined();
    expect(service.rows.size).toBe(0);
  });

  it('400s an off-allowlist metric key, an empty selection and an empty name — writing nothing', async () => {
    const service = new FakeService();
    const bad = (body: unknown) =>
      controllerWith(service).create(
        context,
        principal,
        body as Parameters<InsightCustomReportsController['create']>[2],
      );
    await expectStatus(bad({ name: 'ok', metricKeys: ['not-a-metric'], layout: 'list' }), 400);
    await expectStatus(bad({ name: 'ok', metricKeys: [], layout: 'list' }), 400);
    await expectStatus(bad({ name: '  ', metricKeys: ['open_items'], layout: 'list' }), 400);
    await expectStatus(bad({ name: 'ok', metricKeys: ['open_items'], layout: 'pie' }), 400);
    expect(service.rows.size).toBe(0);
  });

  it('404s a read/replace/delete of a report the store does not resolve for this owner', async () => {
    const service = new FakeService();
    service.ownsNothing = true;
    await expectStatus(controllerWith(service).getById(context, principal, 'other'), 404);
    await expectStatus(controllerWith(service).replace(context, principal, 'other', good), 404);
    await expectStatus(controllerWith(service).remove(context, principal, 'other'), 404);
  });

  it('guards every route with work.read (403 by CapabilityGuard for a caller without it)', () => {
    for (const method of ['list', 'create', 'getById', 'replace', 'remove'] as const) {
      expect(
        Reflect.getMetadata(REQUIRED_CAPABILITY, InsightCustomReportsController.prototype[method]),
      ).toBe('work.read');
    }
  });
});
