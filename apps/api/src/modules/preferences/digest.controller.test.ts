import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { DEFAULT_DIGEST_PREFERENCE, DigestPreferenceController } from './digest.controller.js';
import type { DigestPreferenceRepository } from './digest.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DigestPreference, DigestPreferenceRow } from '../../common/database/schema.js';

/**
 * PREF-DIGEST notification digest cadence (x245) — read/upsert over fakes, always the caller's own.
 *
 * The database is faked; the properties proved are the ones the HTTP surface owns and nothing else
 * does: absence reads the shipped default, a valid save persists and reads back, a fixed-key
 * allowlist rejects an unknown key, a cadence off the closed vocabulary and a send hour / weekday out
 * of range are each a 400 with no write, the subject is `principal.membershipId` and never a body
 * value (so no caller can write another membership's row and another member's row is not readable),
 * and both routes sit behind `work.read` (a caller without it is refused 403 by `CapabilityGuard`,
 * asserted through the route metadata the guard reads).
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
class FakeDigestPreferenceRepository {
  readonly rows = new Map<string, DigestPreference>();
  upsertCalls: { membershipId: string; settings: DigestPreference }[] = [];

  findForMembership(
    _r: unknown,
    _c: unknown,
    membershipId: string,
  ): Promise<DigestPreferenceRow | null> {
    const settings = this.rows.get(membershipId);
    return Promise.resolve(settings ? ({ digestJson: settings } as DigestPreferenceRow) : null);
  }

  upsert(
    _r: unknown,
    _c: unknown,
    membershipId: string,
    settings: DigestPreference,
  ): Promise<void> {
    this.upsertCalls.push({ membershipId, settings });
    this.rows.set(membershipId, settings);
    return Promise.resolve();
  }
}

function controllerWith(repo: FakeDigestPreferenceRepository): DigestPreferenceController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new DigestPreferenceController(database, repo as unknown as DigestPreferenceRepository);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('DigestPreferenceController (PREF-DIGEST, x245)', () => {
  it('reads the shipped default when the member has never saved', async () => {
    const result = await controllerWith(new FakeDigestPreferenceRepository()).get(
      context,
      member(),
    );
    expect(result).toEqual(DEFAULT_DIGEST_PREFERENCE);
  });

  it('persists a valid update and reads it back — always the caller’s own membership', async () => {
    const repo = new FakeDigestPreferenceRepository();
    const controller = controllerWith(repo);

    const saved = await controller.put(context, member(), {
      cadence: 'weekly',
      sendHour: 9,
      dayOfWeek: 3,
    });
    expect(saved).toEqual({ cadence: 'weekly', sendHour: 9, dayOfWeek: 3 });

    // The subject is the authenticated principal's membership, never a value the request named.
    expect(repo.upsertCalls).toHaveLength(1);
    expect(repo.upsertCalls[0]!.membershipId).toBe(MY_MEMBERSHIP);

    const readBack = await controller.get(context, member());
    expect(readBack).toEqual({ cadence: 'weekly', sendHour: 9, dayOfWeek: 3 });
  });

  it('does not read another member’s row — the subject is always the caller', async () => {
    const repo = new FakeDigestPreferenceRepository();
    // Seed only the other member's row; the caller has none, so reads the default, not the other's.
    repo.rows.set(OTHER_MEMBERSHIP, { cadence: 'weekly', sendHour: 6, dayOfWeek: 5 });
    const result = await controllerWith(repo).get(context, member());
    expect(result).toEqual(DEFAULT_DIGEST_PREFERENCE);
  });

  it('400s a body with an off-allowlist key and writes nothing', async () => {
    const repo = new FakeDigestPreferenceRepository();
    // `membershipId` is exactly the field a caller might try to redirect the write with — it is not a
    // known preference, so it is a 400 and the subject stays the authenticated principal's.
    await expectStatus(
      controllerWith(repo).put(context, member(), {
        cadence: 'daily',
        sendHour: 8,
        dayOfWeek: 1,
        membershipId: OTHER_MEMBERSHIP,
      }),
      400,
    );
    expect(repo.upsertCalls).toHaveLength(0);
  });

  it('400s a cadence off the closed vocabulary and writes nothing', async () => {
    const repo = new FakeDigestPreferenceRepository();
    await expectStatus(
      controllerWith(repo).put(context, member(), { cadence: 'hourly', sendHour: 8, dayOfWeek: 1 }),
      400,
    );
    expect(repo.upsertCalls).toHaveLength(0);
  });

  it('400s a send hour and a weekday out of range and writes nothing', async () => {
    const repo = new FakeDigestPreferenceRepository();
    await expectStatus(
      controllerWith(repo).put(context, member(), { cadence: 'daily', sendHour: 24, dayOfWeek: 1 }),
      400,
    );
    await expectStatus(
      controllerWith(repo).put(context, member(), { cadence: 'weekly', sendHour: 8, dayOfWeek: 7 }),
      400,
    );
    expect(repo.upsertCalls).toHaveLength(0);
  });

  it('guards both routes with work.read, so a caller without it is refused 403 by CapabilityGuard', () => {
    for (const method of ['get', 'put'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        DigestPreferenceController.prototype[method],
      );
      expect(capability).toBe('work.read');
    }
  });
});
