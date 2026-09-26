import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { MeetingSeriesController } from './meeting-series.controller.js';
import { MeetingSeriesService } from './meeting-series.service.js';
import type { MeetingSeriesRepository } from './meeting-series.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MeetingSeriesRow } from '../../common/database/schema.js';

/**
 * CAL recurrence (x129) — the controller over a real {@link MeetingSeriesService} (real
 * `authorize()`) and an in-memory repository. The migration and the tenant-scoped SQL round-trip are
 * the chain's DB suite; here the subject is the slice's own decisions: the create→list→expand path,
 * the tenant-scoped 404 for a cross-tenant series, the 90-day window cap, and the capability refusal.
 *
 * One behaviour per test (features budget 0.05). The controller is constructed directly — Nest's
 * parameter decorators are inert metadata — so the handlers run with plain arguments, the way the
 * meetings service test drives its subject.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
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

function controllerWith(seed: readonly MeetingSeriesRow[] = []): {
  controller: MeetingSeriesController;
  store: MeetingSeriesRow[];
} {
  const store: MeetingSeriesRow[] = [...seed];
  let seq = store.length;
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    list: async (_runner: unknown, ctx: TenantContext, _options: { readonly after?: string }) =>
      store.filter((row) => row.organizationId === ctx.organizationId),
    findById: async (_runner: unknown, ctx: TenantContext, seriesId: string) =>
      store.find((row) => row.organizationId === ctx.organizationId && row.id === seriesId) ?? null,
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: {
        readonly title: string;
        readonly freq: MeetingSeriesRow['freq'];
        readonly interval: number;
        readonly until: string | null;
        readonly createdByUserId: string;
      },
    ) => {
      const row = {
        id: `series-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        title: input.title,
        freq: input.freq,
        interval: input.interval,
        until: input.until,
        createdByUserId: input.createdByUserId,
        createdAt: CREATED_AT,
      } as MeetingSeriesRow;
      store.push(row);
      return row;
    },
  } as unknown as MeetingSeriesRepository;
  const service = new MeetingSeriesService(database, repository);
  return { controller: new MeetingSeriesController(service), store };
}

describe('MeetingSeriesController', () => {
  it('creates a series, lists it, then expands its occurrences in a window', async () => {
    const { controller } = controllerWith();
    const created = await controller.create(context, principal('member'), {
      title: 'Weekly sync',
      freq: 'daily',
      interval: 1,
      until: null,
    });
    expect(created.title).toBe('Weekly sync');
    expect(created.freq).toBe('daily');
    // The wire projection never echoes the tenant id.
    expect(JSON.stringify(created)).not.toContain(ORG);

    const listed = await controller.list(context, principal('member'));
    expect(listed.series.map((s) => s.id)).toEqual([created.id]);

    const expanded = await controller.occurrences(
      context,
      principal('member'),
      created.id,
      '2026-10-01',
      '2026-10-05',
    );
    // Daily from the anchor (the created date), five inclusive days.
    expect(expanded.occurrences).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
    ]);
  });

  it('answers 404 for a cross-tenant or unknown series id, reading nothing', async () => {
    const { controller } = controllerWith();
    const error = await controller
      .occurrences(
        context,
        principal('member'),
        'series-does-not-exist',
        '2026-10-01',
        '2026-10-05',
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });

  it('rejects a window wider than 90 days with a 400', async () => {
    const { store } = controllerWith();
    const seeded = {
      id: 'series-seeded-0000-0000-000000000001',
      organizationId: ORG,
      title: 'Daily',
      freq: 'daily',
      interval: 1,
      until: null,
      createdByUserId: USER,
      createdAt: CREATED_AT,
    } as MeetingSeriesRow;
    store.push(seeded);
    const { controller } = controllerWith([seeded]);
    const error = await controller
      .occurrences(context, principal('member'), seeded.id, '2026-10-01', '2027-01-01')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
  });

  it('refuses a create from a role without meeting.write as 403, writing nothing', async () => {
    const { controller, store } = controllerWith();
    // A guest holds meeting.read but not meeting.write.
    const error = await controller
      .create(context, principal('guest'), {
        title: 'No permission',
        freq: 'weekly',
        interval: 1,
        until: null,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect(store).toHaveLength(0);
  });
});
