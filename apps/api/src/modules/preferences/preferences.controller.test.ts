import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { DEFAULT_USER_PREFERENCES, PreferencesController } from './preferences.controller.js';
import type { PreferencesRepository } from './preferences.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { UserPreferenceRow, UserPreferencesJson } from '../../common/database/schema.js';

/**
 * PREF-001 preferences (x182) — read/update over fakes. The database is faked; the rules that are
 * the whole of this slice's safety are not: preferences are own-principal (the read and the upsert
 * are scoped to `context.membershipId`, so one member never reaches another's row), the write is a
 * fixed-key allowlist (an off-list key or value is a 400 with no write), and the routes sit behind
 * `work.read` (a caller without it is refused 403 by `CapabilityGuard`, asserted through the route
 * metadata the guard reads).
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const MY_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';
const OTHER_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e2';

function principal(): Principal {
  return {
    userId: '00000000-0000-4000-8000-0000000000c1',
    organizationId: ORG,
    kind: 'internal',
    role: 'manager',
    membershipId: MY_MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: false,
  };
}

function contextFor(membershipId: string): TenantContext {
  return { organizationId: ORG, membershipId } as unknown as TenantContext;
}

/** An in-memory {@link PreferencesRepository}, keyed by membership so isolation is testable. */
class FakePreferencesRepository {
  readonly rows = new Map<string, UserPreferencesJson>();
  upsertCalls = 0;

  findForMembership(
    _r: unknown,
    _c: unknown,
    membershipId: string,
  ): Promise<UserPreferenceRow | null> {
    const prefs = this.rows.get(membershipId);
    return Promise.resolve(prefs ? ({ prefsJson: prefs } as UserPreferenceRow) : null);
  }

  upsert(
    _r: unknown,
    _c: unknown,
    membershipId: string,
    prefs: UserPreferencesJson,
  ): Promise<void> {
    this.upsertCalls += 1;
    this.rows.set(membershipId, prefs);
    return Promise.resolve();
  }
}

function controllerWith(repo: FakePreferencesRepository): PreferencesController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new PreferencesController(database, repo as unknown as PreferencesRepository);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('PreferencesController (PREF-001, x182)', () => {
  it('reads the defaults when the member has never saved', async () => {
    const controller = controllerWith(new FakePreferencesRepository());
    const view = await controller.get(contextFor(MY_MEMBERSHIP), principal());
    expect(view).toEqual(DEFAULT_USER_PREFERENCES);
  });

  it('persists a valid update and reads it back', async () => {
    const repo = new FakePreferencesRepository();
    const controller = controllerWith(repo);

    const saved = await controller.put(contextFor(MY_MEMBERSHIP), principal(), {
      theme: 'dark',
      locale: 'fr',
      density: 'compact',
    });
    expect(saved).toEqual({ theme: 'dark', locale: 'fr', density: 'compact' });

    const read = await controller.get(contextFor(MY_MEMBERSHIP), principal());
    expect(read).toEqual({ theme: 'dark', locale: 'fr', density: 'compact' });
  });

  it('400s an off-list value and writes nothing', async () => {
    const repo = new FakePreferencesRepository();
    const controller = controllerWith(repo);

    await expectStatus(
      controller.put(contextFor(MY_MEMBERSHIP), principal(), {
        theme: 'midnight',
        locale: 'en',
        density: 'comfortable',
      }),
      400,
    );
    expect(repo.upsertCalls).toBe(0);
    expect(repo.rows.size).toBe(0);
  });

  it('400s an off-list (unknown) key shape and writes nothing', async () => {
    const repo = new FakePreferencesRepository();
    const controller = controllerWith(repo);

    // A body missing the required keys is off the allowlist the same way a bad value is.
    await expectStatus(
      controller.put(contextFor(MY_MEMBERSHIP), principal(), { colour: 'blue' }),
      400,
    );
    expect(repo.upsertCalls).toBe(0);
  });

  it('never reads or overwrites another member’s row (own-principal)', async () => {
    const repo = new FakePreferencesRepository();
    const controller = controllerWith(repo);
    // Another member has saved dark/compact.
    repo.rows.set(OTHER_MEMBERSHIP, { theme: 'dark', locale: 'de', density: 'compact' });

    // The acting member reads their own defaults, not the other member's row.
    expect(await controller.get(contextFor(MY_MEMBERSHIP), principal())).toEqual(
      DEFAULT_USER_PREFERENCES,
    );

    // The acting member's write lands on their own row and leaves the other's untouched.
    await controller.put(contextFor(MY_MEMBERSHIP), principal(), {
      theme: 'light',
      locale: 'en-GB',
      density: 'comfortable',
    });
    expect(repo.rows.get(OTHER_MEMBERSHIP)).toEqual({
      theme: 'dark',
      locale: 'de',
      density: 'compact',
    });
    expect(repo.rows.get(MY_MEMBERSHIP)).toEqual({
      theme: 'light',
      locale: 'en-GB',
      density: 'comfortable',
    });
  });

  it('guards both routes with work.read, so a caller without it is refused 403 by CapabilityGuard', () => {
    for (const method of ['get', 'put'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        PreferencesController.prototype[method],
      );
      expect(capability).toBe('work.read');
    }
  });
});
