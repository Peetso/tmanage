import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { AdminFeatureFlagsController, FeatureFlagsController } from './feature-flags.controller.js';
import type { FeatureFlagsRepository } from './feature-flags.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { OrgFeatureFlagRow } from '../../common/database/schema.js';

/**
 * Per-org feature flags (x278) over fakes with the **real** `authorize`: the two refusals that are
 * the whole of this slice's safety — a key off the fixed allowlist is a 400 with no upsert, and a
 * caller without `org.manage` is a 403 with no upsert — plus the org-scoped resolved read.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';

function owner(): Principal {
  return {
    userId: '00000000-0000-4000-8000-0000000000c1',
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

/** A workspace_admin does not hold `org.manage`, so the real authorize denies. */
function orgAdmin(): Principal {
  return { ...owner(), role: 'workspace_admin' };
}

const context = { organizationId: ORG, membershipId: MEMBERSHIP } as unknown as TenantContext;

class FakeRepo {
  upsertCalls = 0;
  constructor(readonly rows: OrgFeatureFlagRow[] = []) {}
  list(): Promise<OrgFeatureFlagRow[]> {
    return Promise.resolve(this.rows);
  }
  findByKey(_r: unknown, _c: unknown, flagKey: string): Promise<OrgFeatureFlagRow | null> {
    return Promise.resolve(this.rows.find((r) => r.flagKey === flagKey) ?? null);
  }
  upsert(
    _r: unknown,
    _c: unknown,
    input: { flagKey: string; enabled: boolean; updatedBy: string },
  ): Promise<OrgFeatureFlagRow> {
    this.upsertCalls += 1;
    const row: OrgFeatureFlagRow = {
      id: `f-${this.rows.length + 1}`,
      organizationId: ORG,
      flagKey: input.flagKey,
      enabled: input.enabled,
      updatedBy: input.updatedBy,
      updatedAt: new Date('2026-09-27T00:00:00.000Z'),
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }
}

function database(): TenantDatabase {
  return {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('AdminFeatureFlagsController (ADM per-org feature flags, x278)', () => {
  it('enables a known optional-module flag with one upsert', async () => {
    const repo = new FakeRepo();
    const controller = new AdminFeatureFlagsController(
      database(),
      repo as unknown as FeatureFlagsRepository,
    );
    const result = await controller.set(context, owner(), 'chat', { enabled: true });
    expect(repo.upsertCalls).toBe(1);
    expect(result).toMatchObject({ key: 'chat', enabled: true, updatedBy: MEMBERSHIP });
  });

  it('400s a key off the fixed allowlist, without an upsert', async () => {
    const repo = new FakeRepo();
    const controller = new AdminFeatureFlagsController(
      database(),
      repo as unknown as FeatureFlagsRepository,
    );
    await expectStatus(controller.set(context, owner(), 'not_a_module', { enabled: true }), 400);
    expect(repo.upsertCalls).toBe(0);
  });

  it('400s a non-boolean enabled, without an upsert', async () => {
    const repo = new FakeRepo();
    const controller = new AdminFeatureFlagsController(
      database(),
      repo as unknown as FeatureFlagsRepository,
    );
    await expectStatus(controller.set(context, owner(), 'chat', { enabled: 'yes' }), 400);
    expect(repo.upsertCalls).toBe(0);
  });

  it('403s a caller without org.manage (real authorize), without an upsert', async () => {
    const repo = new FakeRepo();
    const controller = new AdminFeatureFlagsController(
      database(),
      repo as unknown as FeatureFlagsRepository,
    );
    await expectStatus(controller.set(context, orgAdmin(), 'chat', { enabled: true }), 403);
    expect(repo.upsertCalls).toBe(0);
  });

  it('guards the write route with org.manage', () => {
    const capability = Reflect.getMetadata(
      REQUIRED_CAPABILITY,
      AdminFeatureFlagsController.prototype.set,
    );
    expect(capability).toBe('org.manage');
  });
});

describe('FeatureFlagsController (resolved read, x278)', () => {
  it('resolves every known flag by its default, a stored row overriding it, behind work.read', async () => {
    // A live module explicitly turned off — the stored value must win over its default-on.
    const stored: OrgFeatureFlagRow = {
      id: 'f-1',
      organizationId: ORG,
      flagKey: 'meetings',
      enabled: false,
      updatedBy: MEMBERSHIP,
      updatedAt: new Date('2026-09-27T00:00:00.000Z'),
    };
    const repo = new FakeRepo([stored]);
    const controller = new FeatureFlagsController(
      database(),
      repo as unknown as FeatureFlagsRepository,
    );
    const result = await controller.resolved(context);
    // Stored row wins over the module default.
    expect(result.flags.meetings).toBe(false);
    // An untouched live module defaults on (ADM-12: switches match a module that works).
    expect(result.flags.chat).toBe(true);
    // The copilot is the one default-off module (it gates the copilot route).
    expect(result.flags.copilot).toBe(false);
    expect(
      Reflect.getMetadata(REQUIRED_CAPABILITY, FeatureFlagsController.prototype.resolved),
    ).toBe('work.read');
  });
});
