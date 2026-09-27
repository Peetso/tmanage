import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { A11yPreferencesController, DEFAULT_A11Y_PREFERENCES } from './a11y.controller.js';
import type { A11yPreferencesRepository } from './a11y.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { A11yPreferenceRow, A11yPreferences } from '../../common/database/schema.js';

/**
 * A11Y-183 accessibility preferences (x183) — read/upsert over fakes, always the caller's own.
 *
 * The database is faked; the properties proved are the ones the HTTP surface owns and nothing else
 * does: absence reads the shipped defaults, a valid save persists and reads back, a fixed-key
 * allowlist rejects an unknown key and a font scale off the closed vocabulary (400, no write), the
 * subject is `principal.membershipId` and never a body value (so no caller can write another
 * membership's row), and both routes sit behind `work.read` (a caller without it is refused 403 by
 * `CapabilityGuard`, asserted through the route metadata the guard reads).
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
class FakeA11yPreferencesRepository {
  readonly rows = new Map<string, A11yPreferences>();
  upsertCalls: { membershipId: string; settings: A11yPreferences }[] = [];

  findForMembership(
    _r: unknown,
    _c: unknown,
    membershipId: string,
  ): Promise<A11yPreferenceRow | null> {
    const settings = this.rows.get(membershipId);
    return Promise.resolve(settings ? ({ a11yJson: settings } as A11yPreferenceRow) : null);
  }

  upsert(_r: unknown, _c: unknown, membershipId: string, settings: A11yPreferences): Promise<void> {
    this.upsertCalls.push({ membershipId, settings });
    this.rows.set(membershipId, settings);
    return Promise.resolve();
  }
}

function controllerWith(repo: FakeA11yPreferencesRepository): A11yPreferencesController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new A11yPreferencesController(database, repo as unknown as A11yPreferencesRepository);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('A11yPreferencesController (A11Y-183, x183)', () => {
  it('reads the shipped defaults when the member has never saved', async () => {
    const repo = new FakeA11yPreferencesRepository();
    const result = await controllerWith(repo).get(context, member());
    expect(result).toEqual(DEFAULT_A11Y_PREFERENCES);
  });

  it('persists a valid update and reads it back — always the caller’s own membership', async () => {
    const repo = new FakeA11yPreferencesRepository();
    const controller = controllerWith(repo);

    const saved = await controller.put(context, member(), {
      fontScale: 'lg',
      reduceMotion: true,
      highContrast: false,
    });
    expect(saved).toEqual({ fontScale: 'lg', reduceMotion: true, highContrast: false });

    // The subject is the authenticated principal's membership, never a value the request named.
    expect(repo.upsertCalls).toHaveLength(1);
    expect(repo.upsertCalls[0]!.membershipId).toBe(MY_MEMBERSHIP);

    const readBack = await controller.get(context, member());
    expect(readBack).toEqual({ fontScale: 'lg', reduceMotion: true, highContrast: false });
  });

  it('400s a body with an off-allowlist key and writes nothing', async () => {
    const repo = new FakeA11yPreferencesRepository();
    // `membershipId` is exactly the field a caller might try to redirect the write with — it is not a
    // known preference, so it is a 400 and the subject stays the authenticated principal's.
    await expectStatus(
      controllerWith(repo).put(context, member(), {
        fontScale: 'md',
        reduceMotion: false,
        highContrast: false,
        membershipId: OTHER_MEMBERSHIP,
      }),
      400,
    );
    expect(repo.upsertCalls).toHaveLength(0);
  });

  it('400s a font scale off the closed vocabulary and writes nothing', async () => {
    const repo = new FakeA11yPreferencesRepository();
    await expectStatus(
      controllerWith(repo).put(context, member(), {
        fontScale: 'huge',
        reduceMotion: false,
        highContrast: false,
      }),
      400,
    );
    expect(repo.upsertCalls).toHaveLength(0);
  });

  it('400s a non-boolean toggle and writes nothing', async () => {
    const repo = new FakeA11yPreferencesRepository();
    await expectStatus(
      controllerWith(repo).put(context, member(), {
        fontScale: 'md',
        reduceMotion: 'yes',
        highContrast: false,
      }),
      400,
    );
    expect(repo.upsertCalls).toHaveLength(0);
  });

  it('guards both routes with work.read, so a caller without it is refused 403 by CapabilityGuard', () => {
    for (const method of ['get', 'put'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        A11yPreferencesController.prototype[method],
      );
      expect(capability).toBe('work.read');
    }
  });
});
