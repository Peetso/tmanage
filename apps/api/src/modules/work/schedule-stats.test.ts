import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  driversOf,
  registerScheduleStats,
  requestScheduleRecompute,
  ScheduleStatsService,
  SCHEDULE_RECOMPUTE_DEBOUNCE_MS,
} from './schedule-stats.service.js';
import type { ScheduleStatsItemRow, ScheduleStatsRepository } from './schedule-stats.repository.js';
import { MAX_GRAPH_NODES } from './work-graph.repository.js';

/** 53-06: INT 53-T-15 debounce, the 422 over the cap, and drivers counted (never named) when hidden. */
const ORG = 'org-1';
const context = { organizationId: ORG, correlationId: 'c' } as unknown as TenantContext;
const database = {
  read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
  transaction: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
} as unknown as TenantDatabase;

afterEach(() => {
  registerScheduleStats(null);
  vi.useRealTimers();
});

describe('ScheduleStatsService', () => {
  it('coalesces 50 requests for one project into one recompute 2 s after the last', async () => {
    vi.useFakeTimers();
    const service = new ScheduleStatsService(database);
    const recompute = vi.spyOn(service, 'recompute').mockResolvedValue({} as never);
    registerScheduleStats(service);
    for (let i = 0; i < 50; i += 1) requestScheduleRecompute(context, 'p1', 'p1');
    await vi.advanceTimersByTimeAsync(SCHEDULE_RECOMPUTE_DEBOUNCE_MS - 1);
    expect(recompute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(recompute).toHaveBeenCalledTimes(1);
  });

  it('answers 422 project_too_large over the cap and writes nothing', async () => {
    const replaceProject = vi.fn();
    const items = Array.from({ length: MAX_GRAPH_NODES + 1 }, (_, i) => ({ id: `w${i}` }));
    const stats = { listProjectItems: async () => items, replaceProject };
    const service = new ScheduleStatsService(database, stats as unknown as ScheduleStatsRepository);
    await expect(service.recompute(context, 'p1')).rejects.toMatchObject({
      status: 422,
      auditCode: 'project_too_large',
    });
    expect(replaceProject).not.toHaveBeenCalled();
  });

  it('names readable drivers and counts the hidden ones', () => {
    const row = (id: string, readable: boolean) =>
      ({
        workItemId: id,
        title: id,
        isCritical: true,
        readable,
      }) as unknown as ScheduleStatsItemRow;
    const rows = [row('a', true), row('b', false), row('c', true), row('d', true)];
    const mayRead = (r: ScheduleStatsItemRow) => (r as unknown as { readable: boolean }).readable;
    expect(driversOf(rows, mayRead)).toEqual({
      drivers: [
        { id: 'a', title: 'a' },
        { id: 'c', title: 'c' },
      ],
      hiddenDrivers: 1,
    });
  });
});
