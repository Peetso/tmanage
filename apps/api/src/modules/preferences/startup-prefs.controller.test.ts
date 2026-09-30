import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { StartupPrefsController } from './startup-prefs.controller.js';
import type { StartupPrefsRepository } from './startup-prefs.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { LandingKey, UserStartupPrefRow } from '../../common/database/schema.js';

/**
 * PREF-STARTUP default startup landing view (x287) — read/upsert over fakes, always the caller's own.
 *
 * The database is faked; the properties proved are the ones the HTTP surface owns: absence reads the
 * shipped default (`home`), a valid save persists and reads back, the subject is
 * `principal.membershipId` and never a body value (so no caller writes another membership's row), a
 * `landingKey` off the allowlist is a 400 with no write, and every route sits behind `work.read`.
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

class FakeStartupPrefsRepository {
  readonly rows = new Map<string, LandingKey>();
  upsertCalls: { membershipId: string; landingKey: LandingKey }[] = [];

  findForMembership(
    _r: unknown,
    _c: unknown,
    membershipId: string,
  ): Promise<UserStartupPrefRow | null> {
    const landingKey = this.rows.get(membershipId);
    return Promise.resolve(landingKey ? ({ landingKey } as UserStartupPrefRow) : null);
  }

  upsert(_r: unknown, _c: unknown, membershipId: string, landingKey: LandingKey): Promise<void> {
    this.upsertCalls.push({ membershipId, landingKey });
    this.rows.set(membershipId, landingKey);
    return Promise.resolve();
  }
}

function controllerWith(service: FakeStartupPrefsRepository): StartupPrefsController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new StartupPrefsController(database, service as unknown as StartupPrefsRepository);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('StartupPrefsController (PREF-STARTUP, x287)', () => {
  it('reads the shipped default (home) when the member has never saved', async () => {
    const result = await controllerWith(new FakeStartupPrefsRepository()).get(context, member());
    expect(result).toEqual({ landingKey: 'home' });
  });

  it('persists a valid save and reads it back — always the caller’s own membership', async () => {
    const service = new FakeStartupPrefsRepository();
    const controller = controllerWith(service);

    const saved = await controller.put(context, member(), { landingKey: 'inbox' });
    expect(saved).toEqual({ landingKey: 'inbox' });
    expect(service.upsertCalls).toHaveLength(1);
    expect(service.upsertCalls[0]!.membershipId).toBe(MY_MEMBERSHIP);

    const readBack = await controller.get(context, member());
    expect(readBack).toEqual({ landingKey: 'inbox' });
  });

  it('refuses a landingKey off the allowlist (payroll) with 400 and writes nothing', async () => {
    const service = new FakeStartupPrefsRepository();
    await expectStatus(
      controllerWith(service).put(context, member(), { landingKey: 'payroll' } as unknown),
      400,
    );
    expect(service.upsertCalls).toHaveLength(0);
  });

  it('does not read another membership’s row, and a stray body key is a 400 with no write', async () => {
    const service = new FakeStartupPrefsRepository();
    service.rows.set(OTHER_MEMBERSHIP, 'calendar');

    // The caller has no row of their own → default, never the other member's stored preference.
    const mine = await controllerWith(service).get(context, member());
    expect(mine).toEqual({ landingKey: 'home' });

    // `membershipId` is exactly the field a caller might try to redirect the write with — off-allowlist.
    await expectStatus(
      controllerWith(service).put(context, member(), {
        landingKey: 'inbox',
        membershipId: OTHER_MEMBERSHIP,
      } as unknown),
      400,
    );
    expect(service.upsertCalls).toHaveLength(0);
  });

  it('guards every route with work.read, so a caller without it is refused 403 by CapabilityGuard', () => {
    for (const method of ['get', 'put'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        StartupPrefsController.prototype[method],
      );
      expect(capability).toBe('work.read');
    }
  });
});
