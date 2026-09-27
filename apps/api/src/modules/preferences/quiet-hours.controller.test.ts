import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { DEFAULT_QUIET_HOURS, QuietHoursController } from './quiet-hours.controller.js';
import { isWithinQuietHours } from './quiet-hours.service.js';
import type { QuietHoursRepository } from './quiet-hours.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { QuietHours, QuietHoursRow } from '../../common/database/schema.js';

/**
 * PREF-QUIET notification quiet hours (x215) — read/upsert/active over fakes, always the caller's own.
 *
 * The database is faked; the properties proved are the ones the HTTP surface owns: absence reads the
 * shipped defaults, a valid save persists and reads back, the subject is `principal.membershipId` and
 * never a body value (so no caller reads or writes another membership's row), the fixed-key allowlist
 * and field validators reject bad input with 400 and no write, the active check is timezone-aware
 * against a bound clock, and every route sits behind `work.read`.
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

class FakeQuietHoursRepository {
  readonly rows = new Map<string, QuietHours>();
  upsertCalls: { membershipId: string; settings: QuietHours }[] = [];

  findForMembership(_r: unknown, _c: unknown, membershipId: string): Promise<QuietHoursRow | null> {
    const settings = this.rows.get(membershipId);
    return Promise.resolve(settings ? ({ quietJson: settings } as QuietHoursRow) : null);
  }

  upsert(_r: unknown, _c: unknown, membershipId: string, settings: QuietHours): Promise<void> {
    this.upsertCalls.push({ membershipId, settings });
    this.rows.set(membershipId, settings);
    return Promise.resolve();
  }
}

function controllerWith(service: FakeQuietHoursRepository): QuietHoursController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new QuietHoursController(database, service as unknown as QuietHoursRepository);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

const VALID: QuietHours = {
  enabled: true,
  startTime: '22:00',
  endTime: '07:00',
  timezone: 'America/New_York',
  days: [1, 2, 3, 4, 5],
};

describe('QuietHoursController (PREF-QUIET, x215)', () => {
  it('reads the shipped defaults when the member has never saved', async () => {
    const result = await controllerWith(new FakeQuietHoursRepository()).get(context, member());
    expect(result).toEqual(DEFAULT_QUIET_HOURS);
  });

  it('persists a valid save and reads it back — always the caller’s own membership', async () => {
    const service = new FakeQuietHoursRepository();
    const controller = controllerWith(service);

    const saved = await controller.put(context, member(), { ...VALID });
    expect(saved).toEqual(VALID);
    expect(service.upsertCalls).toHaveLength(1);
    expect(service.upsertCalls[0]!.membershipId).toBe(MY_MEMBERSHIP);

    const readBack = await controller.get(context, member());
    expect(readBack).toEqual(VALID);
  });

  it('does not read another membership’s row — the subject is the principal, and a body key is a 400', async () => {
    const service = new FakeQuietHoursRepository();
    service.rows.set(OTHER_MEMBERSHIP, { ...VALID, timezone: 'UTC' });

    // The caller has no row of their own → defaults, never the other member's stored window.
    const mine = await controllerWith(service).get(context, member());
    expect(mine).toEqual(DEFAULT_QUIET_HOURS);

    // `membershipId` is exactly the field a caller might try to redirect the write with — off-allowlist.
    await expectStatus(
      controllerWith(service).put(context, member(), {
        ...VALID,
        membershipId: OTHER_MEMBERSHIP,
      } as unknown),
      400,
    );
    expect(service.upsertCalls).toHaveLength(0);
  });

  it('400s a malformed time and writes nothing', async () => {
    const service = new FakeQuietHoursRepository();
    await expectStatus(
      controllerWith(service).put(context, member(), { ...VALID, endTime: '7am' }),
      400,
    );
    expect(service.upsertCalls).toHaveLength(0);
  });

  it('400s an unknown timezone and a bad weekday and writes nothing', async () => {
    const service = new FakeQuietHoursRepository();
    await expectStatus(
      controllerWith(service).put(context, member(), { ...VALID, timezone: 'Mars/Olympus' }),
      400,
    );
    await expectStatus(
      controllerWith(service).put(context, member(), { ...VALID, days: [7] }),
      400,
    );
    expect(service.upsertCalls).toHaveLength(0);
  });

  it('guards every route with work.read, so a caller without it is refused 403 by CapabilityGuard', () => {
    for (const method of ['get', 'active', 'put'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        QuietHoursController.prototype[method],
      );
      expect(capability).toBe('work.read');
    }
  });
});

describe('isWithinQuietHours (PREF-QUIET, x215) — timezone-aware against a bound clock', () => {
  // 2026-06-15 is a Monday. 03:00 UTC is Sunday 23:00 in New York (UTC-4 in June).
  const utc0300Mon = new Date('2026-06-15T03:00:00Z');
  const nightWindow: QuietHours = {
    enabled: true,
    startTime: '22:00',
    endTime: '07:00',
    timezone: 'America/New_York',
    days: [0, 1, 2, 3, 4, 5, 6],
  };

  it('is active inside the window in the stored timezone (Sunday 23:00 local, wrapping midnight)', () => {
    expect(isWithinQuietHours(nightWindow, utc0300Mon)).toBe(true);
  });

  it('is inactive outside the window in the stored timezone (Monday 12:00 local)', () => {
    // 16:00 UTC on the Monday is 12:00 in New York — well outside 22:00–07:00.
    expect(isWithinQuietHours(nightWindow, new Date('2026-06-15T16:00:00Z'))).toBe(false);
  });

  it('is never active when disabled', () => {
    expect(isWithinQuietHours({ ...nightWindow, enabled: false }, utc0300Mon)).toBe(false);
  });

  it('is inactive when the local weekday is not in days', () => {
    // Sunday 23:00 local, but days excludes Sunday (0).
    expect(isWithinQuietHours({ ...nightWindow, days: [1, 2, 3, 4, 5] }, utc0300Mon)).toBe(false);
  });
});
