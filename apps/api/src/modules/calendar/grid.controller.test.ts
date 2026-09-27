import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { CalendarGridController } from './grid.controller.js';
import { CalendarGridService } from './grid.service.js';
import type { MeetingAgendaRepository } from './meeting-agenda.repository.js';
import type { MeetingSeriesRepository } from './meeting-series.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MeetingRow, MeetingSeriesRow } from '../../common/database/schema.js';

/**
 * CAL week/month grid (x212). The controller/service logic, database-free over fakes with the
 * **real** `authorize()`. The tenant-scoped SQL and migration are the chain's concern (no DB test);
 * here the subjects are the window derivation, the day bucketing of meetings and recurrence
 * occurrences, the bounded expansion, and the relation filter. The fakes deliberately omit the
 * tenant scope the real SQL applies, so a cross-tenant row must be dropped by `authorize()`.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';
const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function member(projectIds: readonly string[], hasOrgWideScope = false): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: hasOrgWideScope ? 'owner' : 'member',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope,
  };
}

function meeting(id: string, startsAt: string, over: Partial<MeetingRow> = {}): MeetingRow {
  return {
    id,
    organizationId: ORG,
    projectId: PROJECT,
    title: `Meeting ${id}`,
    startsAt: new Date(startsAt),
    agendaNote: null,
    createdByUserId: USER,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...over,
  } as MeetingRow;
}

function series(id: string, over: Partial<MeetingSeriesRow> = {}): MeetingSeriesRow {
  return {
    id,
    organizationId: ORG,
    title: `Series ${id}`,
    freq: 'daily',
    interval: 1,
    until: null,
    createdByUserId: USER,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    ...over,
  } as MeetingSeriesRow;
}

function controllerWith(
  meetings: readonly MeetingRow[] = [],
  seriesRows: readonly MeetingSeriesRow[] = [],
): CalendarGridController {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const agenda = { listInWindow: async () => [...meetings] } as unknown as MeetingAgendaRepository;
  const seriesRepo = { list: async () => [...seriesRows] } as unknown as MeetingSeriesRepository;
  return new CalendarGridController(new CalendarGridService(database, agenda, seriesRepo));
}

describe('CalendarGridController', () => {
  it('requires the meeting.read capability on the grid route', () => {
    const capability = Reflect.getMetadata(
      REQUIRED_CAPABILITY,
      CalendarGridController.prototype.gridView,
    );
    expect(capability).toBe('meeting.read');
  });

  it('buckets meetings and expanded occurrences by day across the whole month window', async () => {
    const controller = controllerWith(
      [meeting('meeting-0000-0000-0000-000000000001', '2026-10-05T09:00:00.000Z')],
      [series('series-0000-0000-0000-0000-00000001')], // daily from 2026-10-01
    );

    const view = await controller.gridView(context, member([PROJECT]), 'month', '2026-10-15');

    expect(view.range).toBe('month');
    expect(view.from).toBe('2026-10-01');
    expect(view.to).toBe('2026-10-31');
    expect(view.days).toHaveLength(31); // every day is a cell, including empty ones
    const oct5 = view.days.find((day) => day.date === '2026-10-05');
    expect(oct5?.meetings.map((m) => m.id)).toEqual(['meeting-0000-0000-0000-000000000001']);
    // A daily series anchored Oct 1 recurs on every day of the window.
    expect(view.days.every((day) => day.occurrences.length === 1)).toBe(true);
    expect(JSON.stringify(view)).not.toContain(ORG);
  });

  it('derives a Monday-based week window from the anchor', async () => {
    const view = await controllerWith().gridView(context, member([PROJECT]), 'week', '2026-10-15'); // Thu
    expect(view.from).toBe('2026-10-12'); // Monday
    expect(view.to).toBe('2026-10-18'); // Sunday
    expect(view.days).toHaveLength(7);
  });

  it('drops a cross-tenant meeting via the relation filter', async () => {
    const controller = controllerWith([
      meeting('meeting-foreign-000000000000000011', '2026-10-05T09:00:00.000Z', {
        organizationId: OTHER_ORG,
      }),
    ]);
    const view = await controller.gridView(context, member([], true), 'month', '2026-10-15');
    expect(view.days.flatMap((day) => day.meetings)).toEqual([]);
    expect(JSON.stringify(view)).not.toContain(OTHER_ORG);
  });

  it('refuses a missing or malformed range or anchor with a 400', async () => {
    const controller = controllerWith();
    for (const [range, anchor] of [
      [undefined, '2026-10-15'],
      ['fortnight', '2026-10-15'],
      ['month', 'not-a-date'],
      ['month', undefined],
    ] as const) {
      const error = await controller
        .gridView(context, member([PROJECT]), range, anchor)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(400);
    }
  });
});
