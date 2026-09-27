import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { HomeWidgetPrefsController, DEFAULT_HOME_WIDGET_PREFS } from './widget-prefs.controller.js';
import type { HomeWidgetPrefsRepository } from './widget-prefs.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { HomeWidgetPrefRow, HomeWidgetPrefs } from '../../common/database/schema.js';

/**
 * Home widget preferences (x243) — read/upsert over fakes, always the caller's own.
 *
 * The database is faked; the properties proved are the ones the HTTP surface owns: absence reads the
 * shipped default, a valid save persists and reads back, the order is de-duplicated, an unknown
 * widget id is a 400 with no write, the subject is `principal.membershipId` and never a body value
 * (so no caller can read or write another membership's layout), and both routes sit behind
 * `work.read` (a caller without it is refused 403 by `CapabilityGuard`, asserted through the route
 * metadata the guard reads).
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const MY_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';
const OTHER_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e2';

function member(): Principal {
  return {
    userId: '00000000-0000-4000-8000-0000000000c1',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: MY_MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: false,
  };
}

const context = { organizationId: ORG, membershipId: MY_MEMBERSHIP } as unknown as TenantContext;

/** An in-memory store keyed by membership, so a save is visible to the read-back it does. */
class FakeHomeWidgetPrefsRepository {
  readonly rows = new Map<string, HomeWidgetPrefs>();
  upsertCalls: { membershipId: string; prefs: HomeWidgetPrefs }[] = [];

  findForMembership(
    _r: unknown,
    _c: unknown,
    membershipId: string,
  ): Promise<HomeWidgetPrefRow | null> {
    const prefs = this.rows.get(membershipId);
    return Promise.resolve(
      prefs
        ? ({ widgetOrderJson: prefs.order, hiddenWidgetsJson: prefs.hidden } as HomeWidgetPrefRow)
        : null,
    );
  }

  upsert(_r: unknown, _c: unknown, membershipId: string, prefs: HomeWidgetPrefs): Promise<void> {
    this.upsertCalls.push({ membershipId, prefs });
    this.rows.set(membershipId, prefs);
    return Promise.resolve();
  }
}

function controllerWith(service: FakeHomeWidgetPrefsRepository): HomeWidgetPrefsController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new HomeWidgetPrefsController(database, service as unknown as HomeWidgetPrefsRepository);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('HomeWidgetPrefsController (x243)', () => {
  it('reads the shipped default when the member has never saved', async () => {
    const service = new FakeHomeWidgetPrefsRepository();
    const result = await controllerWith(service).get(context, member());
    expect(result).toEqual(DEFAULT_HOME_WIDGET_PREFS);
  });

  it('persists a valid layout and reads it back — always the caller’s own membership', async () => {
    const service = new FakeHomeWidgetPrefsRepository();
    const controller = controllerWith(service);

    const saved = await controller.put(context, member(), {
      order: ['waiting', 'myDay', 'pulse'],
      hidden: ['pins'],
    });
    expect(saved).toEqual({ order: ['waiting', 'myDay', 'pulse'], hidden: ['pins'] });

    // The subject is the authenticated principal's membership, never a value the request named.
    expect(service.upsertCalls).toHaveLength(1);
    expect(service.upsertCalls[0]!.membershipId).toBe(MY_MEMBERSHIP);

    const readBack = await controller.get(context, member());
    expect(readBack).toEqual({ order: ['waiting', 'myDay', 'pulse'], hidden: ['pins'] });
  });

  it('de-duplicates the order, first occurrence wins', async () => {
    const service = new FakeHomeWidgetPrefsRepository();
    const saved = await controllerWith(service).put(context, member(), {
      order: ['myDay', 'waiting', 'myDay', 'pulse', 'waiting'],
      hidden: [],
    });
    expect(saved.order).toEqual(['myDay', 'waiting', 'pulse']);
  });

  it('400s a body with an unknown widget id and writes nothing', async () => {
    const service = new FakeHomeWidgetPrefsRepository();
    await expectStatus(
      controllerWith(service).put(context, member(), {
        order: ['myDay', 'not-a-widget'],
        hidden: [],
      }),
      400,
    );
    expect(service.upsertCalls).toHaveLength(0);
  });

  it('400s a non-array field and writes nothing', async () => {
    const service = new FakeHomeWidgetPrefsRepository();
    await expectStatus(
      controllerWith(service).put(context, member(), { order: 'myDay', hidden: [] }),
      400,
    );
    expect(service.upsertCalls).toHaveLength(0);
  });

  it('never reads another membership’s layout — the subject is always the principal', async () => {
    const service = new FakeHomeWidgetPrefsRepository();
    // Another member has a saved layout; the caller must not see it.
    service.rows.set(OTHER_MEMBERSHIP, { order: ['pulse'], hidden: ['myDay'] });
    const result = await controllerWith(service).get(context, member());
    expect(result).toEqual(DEFAULT_HOME_WIDGET_PREFS);
  });

  it('guards both routes with work.read, so a caller without it is refused 403 by CapabilityGuard', () => {
    for (const method of ['get', 'put'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        HomeWidgetPrefsController.prototype[method],
      );
      expect(capability).toBe('work.read');
    }
  });
});
