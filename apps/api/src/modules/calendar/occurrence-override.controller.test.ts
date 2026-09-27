import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { OccurrenceOverrideController } from './occurrence-override.controller.js';
import { OccurrenceOverrideService, applyOverrides } from './occurrence-override.service.js';
import type { MeetingOccurrenceOverrideRepository } from './occurrence-override.repository.js';
import type { MeetingSeriesRepository } from './meeting-series.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  MeetingOccurrenceOverrideRow,
  MeetingSeriesRow,
} from '../../common/database/schema.js';

/**
 * CAL per-occurrence override (x213) — the controller over a real {@link OccurrenceOverrideService}
 * (real `authorize()`) and in-memory repositories. The migration and the tenant-scoped SQL round-trip
 * are the chain's DB suite; here the subject is the slice's own decisions: the upsert→read path, the
 * deterministic merge, the tenant-scoped 404 for a cross-tenant series, the non-occurrence-date 400,
 * and the capability refusal. One behaviour per test (features budget 0.05).
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const USER = 'user-0000-0000-0000-0000-000000000001';
/** A fixed creation date so the expansion anchor (the series' created date) is deterministic. */
const CREATED_AT = new Date('2026-10-01T00:00:00.000Z');

function principal(role: Principal['role']): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: role === 'owner',
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

/** A daily series so every date on/after the anchor is a valid occurrence. */
const DAILY_SERIES = {
  id: 'series-0000-0000-0000-000000000001',
  organizationId: ORG,
  title: 'Daily standup',
  freq: 'daily',
  interval: 1,
  until: null,
  createdByUserId: USER,
  createdAt: CREATED_AT,
} as MeetingSeriesRow;

function controllerWith(series: readonly MeetingSeriesRow[] = [DAILY_SERIES]): {
  controller: OccurrenceOverrideController;
  store: Map<string, MeetingOccurrenceOverrideRow>;
} {
  const seriesStore = [...series];
  const store = new Map<string, MeetingOccurrenceOverrideRow>();
  const key = (org: string, s: string, d: string) => `${org}:${s}:${d}`;

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const seriesRepository = {
    findById: async (_runner: unknown, ctx: TenantContext, id: string) =>
      seriesStore.find((row) => row.organizationId === ctx.organizationId && row.id === id) ?? null,
  } as unknown as MeetingSeriesRepository;

  const overrideRepository = {
    upsert: async (
      _runner: unknown,
      ctx: TenantContext,
      input: {
        readonly seriesId: string;
        readonly occurrenceDate: string;
        readonly status: MeetingOccurrenceOverrideRow['status'];
        readonly newDate: string | null;
        readonly newStartTime: string | null;
        readonly newTitle: string | null;
        readonly createdByUserId: string;
      },
    ) => {
      const row = {
        id: 'override-0000-0000-0000-000000000001',
        organizationId: ctx.organizationId,
        seriesId: input.seriesId,
        occurrenceDate: input.occurrenceDate,
        status: input.status,
        newDate: input.newDate,
        newStartTime: input.newStartTime,
        newTitle: input.newTitle,
        createdByUserId: input.createdByUserId,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      } as MeetingOccurrenceOverrideRow;
      store.set(key(ctx.organizationId, input.seriesId, input.occurrenceDate), row);
      return row;
    },
    findByDate: async (_runner: unknown, ctx: TenantContext, s: string, d: string) =>
      store.get(key(ctx.organizationId, s, d)) ?? null,
    deleteByDate: async (_runner: unknown, ctx: TenantContext, s: string, d: string) =>
      store.delete(key(ctx.organizationId, s, d)),
  } as unknown as MeetingOccurrenceOverrideRepository;

  const service = new OccurrenceOverrideService(database, overrideRepository, seriesRepository);
  return { controller: new OccurrenceOverrideController(service), store };
}

describe('applyOverrides', () => {
  it('drops a cancelled occurrence and moves a moved one, deterministically', () => {
    const base = ['2026-10-01', '2026-10-02', '2026-10-03'];
    const merged = applyOverrides(base, [
      {
        occurrenceDate: '2026-10-02',
        status: 'cancelled',
        newDate: null,
        newStartTime: null,
        newTitle: null,
      },
      {
        occurrenceDate: '2026-10-03',
        status: 'moved',
        newDate: '2026-10-05',
        newStartTime: '09:30:00',
        newTitle: 'Moved standup',
      },
    ]);
    expect(merged.map((m) => m.date)).toEqual(['2026-10-01', '2026-10-05']);
    expect(merged[1]).toMatchObject({
      date: '2026-10-05',
      startTime: '09:30:00',
      title: 'Moved standup',
      movedFrom: '2026-10-03',
    });
  });
});

describe('OccurrenceOverrideController', () => {
  it('upserts an override for a valid occurrence date and reads it back, omitting the tenant id', async () => {
    const { controller } = controllerWith();
    const saved = await controller.upsert(
      context,
      principal('member'),
      DAILY_SERIES.id,
      '2026-10-03',
      {
        status: 'moved',
        newDate: '2026-10-05',
      },
    );
    expect(saved.status).toBe('moved');
    expect(saved.newDate).toBe('2026-10-05');
    expect(JSON.stringify(saved)).not.toContain(ORG);

    const read = await controller.get(context, principal('member'), DAILY_SERIES.id, '2026-10-03');
    expect(read.occurrenceDate).toBe('2026-10-03');
  });

  it('answers 404 for a cross-tenant or unknown series id, writing nothing', async () => {
    const { controller, store } = controllerWith([]);
    const error = await controller
      .upsert(context, principal('member'), 'series-does-not-exist', '2026-10-03', {
        status: 'cancelled',
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store.size).toBe(0);
  });

  it('rejects an override on a date that is not an occurrence of the series with a 400', async () => {
    // A weekly series anchored on 2026-10-01 does not fall on 2026-10-02.
    const weekly = { ...DAILY_SERIES, freq: 'weekly' } as MeetingSeriesRow;
    const { controller, store } = controllerWith([weekly]);
    const error = await controller
      .upsert(context, principal('member'), weekly.id, '2026-10-02', { status: 'cancelled' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect(store.size).toBe(0);
  });

  it('refuses a write from a role without meeting.write as 403, writing nothing', async () => {
    const { controller, store } = controllerWith();
    // A guest holds meeting.read but not meeting.write.
    const error = await controller
      .upsert(context, principal('guest'), DAILY_SERIES.id, '2026-10-03', { status: 'cancelled' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect(store.size).toBe(0);
  });

  it('answers 404 when clearing an override that does not exist', async () => {
    const { controller } = controllerWith();
    const error = await controller
      .remove(context, principal('member'), DAILY_SERIES.id, '2026-10-03')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });

  it('reads across tenants return nothing: a series in another org is a 404', async () => {
    const otherSeries = { ...DAILY_SERIES, organizationId: OTHER_ORG } as MeetingSeriesRow;
    const { controller } = controllerWith([otherSeries]);
    const error = await controller
      .get(context, principal('member'), otherSeries.id, '2026-10-03')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });
});
