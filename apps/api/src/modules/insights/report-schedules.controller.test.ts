import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { InsightReportSchedulesController } from './report-schedules.controller.js';
import { computeNextRunAt } from './report-schedules.service.js';
import type {
  InsightReportScheduleInput,
  InsightReportSchedulesService,
} from './report-schedules.service.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { InsightReportScheduleRow } from '../../common/database/schema.js';

/**
 * INS report schedules (x228) — the HTTP surface over a fake service, always the caller's own: create
 * persists and reads back, an unknown report key / cadence / out-of-range hour / missing weekly day is
 * a 400 with no write, a delete the store does not remove for this owner is a 404, and all three
 * routes sit behind `work.read` (a caller without it is refused 403 by `CapabilityGuard`). The
 * next-run compute is deterministic and clock-free — proven directly on the pure helper.
 */

const ME = '00000000-0000-4000-8000-0000000000c1';
const context = { organizationId: 'org', userId: ME } as unknown as TenantContext;
const principal = { userId: ME } as unknown as Principal;

/** In-memory store keyed by id, scoped to the acting user, so a save is visible to its read-back. */
class FakeService {
  readonly rows = new Map<string, InsightReportScheduleRow>();
  private n = 0;
  denyDelete = false;

  create(
    _c: TenantContext,
    input: InsightReportScheduleInput,
    now: Date,
  ): Promise<InsightReportScheduleRow> {
    const id = `00000000-0000-7000-8000-00000000000${++this.n}`;
    const row = {
      id,
      organizationId: 'org',
      ownerUserId: ME,
      reportKey: input.reportKey,
      cadence: input.cadence,
      hour: input.hour,
      dayOfWeek: input.dayOfWeek,
      nextRunAt: computeNextRunAt(now, input.cadence, input.hour, input.dayOfWeek),
      createdAt: new Date('2026-09-27T00:00:00.000Z'),
    } as unknown as InsightReportScheduleRow;
    this.rows.set(id, row);
    return Promise.resolve(row);
  }
  listOwn(): Promise<InsightReportScheduleRow[]> {
    return Promise.resolve([...this.rows.values()]);
  }
  deleteOwn(_c: TenantContext, id: string): Promise<boolean> {
    return Promise.resolve(this.denyDelete ? false : this.rows.delete(id));
  }
}

function controllerWith(service: FakeService): InsightReportSchedulesController {
  return new InsightReportSchedulesController(service as unknown as InsightReportSchedulesService);
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

type CreateBody = Parameters<InsightReportSchedulesController['create']>[2];

describe('InsightReportSchedulesController (x228)', () => {
  it('creates a weekly schedule, lists it, then deletes it — always the caller’s own', async () => {
    const service = new FakeService();
    const controller = controllerWith(service);

    const created = await controller.create(context, principal, {
      reportKey: 'delivery-flow',
      cadence: 'weekly',
      hour: 8,
      dayOfWeek: 1,
    } satisfies Record<string, unknown> as CreateBody);
    expect(created.ownerUserId).toBe(ME);
    expect(created.reportKey).toBe('delivery-flow');
    expect(created.cadence).toBe('weekly');
    expect(created.dayOfWeek).toBe(1);

    expect((await controller.list(context, principal)).schedules).toHaveLength(1);
    expect((await controller.remove(context, principal, created.id)).schedules).toHaveLength(0);
  });

  it('400s an unknown key, a bad cadence, an out-of-range hour and a weekly schedule with no day', async () => {
    const service = new FakeService();
    const bad = (body: unknown) =>
      controllerWith(service).create(context, principal, body as CreateBody);
    await expectStatus(bad({ reportKey: 'nope', cadence: 'daily', hour: 8 }), 400);
    await expectStatus(bad({ reportKey: 'portfolio', cadence: 'monthly', hour: 8 }), 400);
    await expectStatus(bad({ reportKey: 'portfolio', cadence: 'daily', hour: 24 }), 400);
    await expectStatus(bad({ reportKey: 'portfolio', cadence: 'weekly', hour: 8 }), 400);
    expect(service.rows.size).toBe(0);
  });

  it('404s a delete of a schedule the store does not remove for this owner (other user’s / absent)', async () => {
    const service = new FakeService();
    service.denyDelete = true;
    await expectStatus(controllerWith(service).remove(context, principal, 'x'), 404);
  });

  it('guards all three routes with report.view (403 by CapabilityGuard for a caller without it)', () => {
    for (const method of ['list', 'create', 'remove'] as const) {
      expect(
        Reflect.getMetadata(
          REQUIRED_CAPABILITY,
          InsightReportSchedulesController.prototype[method],
        ),
      ).toBe('report.view');
    }
  });

  it('computes next_run_at deterministically in UTC, strictly after now', () => {
    const now = new Date('2026-09-27T10:30:00.000Z'); // a Sunday (getUTCDay 0)
    // daily at 08:00 — already past today, so tomorrow 08:00.
    expect(computeNextRunAt(now, 'daily', 8, null).toISOString()).toBe('2026-09-28T08:00:00.000Z');
    // daily at 20:00 — still ahead today.
    expect(computeNextRunAt(now, 'daily', 20, null).toISOString()).toBe('2026-09-27T20:00:00.000Z');
    // weekly on Monday (1) at 08:00 — the next day.
    expect(computeNextRunAt(now, 'weekly', 8, 1).toISOString()).toBe('2026-09-28T08:00:00.000Z');
    // weekly on Sunday (0) at 20:00 — later today.
    expect(computeNextRunAt(now, 'weekly', 20, 0).toISOString()).toBe('2026-09-27T20:00:00.000Z');
    // weekly on Sunday (0) at 08:00 — already past today, so next Sunday.
    expect(computeNextRunAt(now, 'weekly', 8, 0).toISOString()).toBe('2026-10-04T08:00:00.000Z');
  });
});
