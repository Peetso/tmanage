import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { PoliciesController } from './policies.controller.js';
import type { PoliciesRepository } from './policies.repository.js';
import { DEFAULT_POLICY } from './policies.allowlist.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { OrgPolicyRow, OrgPolicyValue } from '../../common/database/schema.js';

/**
 * Organization access policies (x174) read + update over fakes, with the **real** `authorize`.
 *
 * The database is faked, but the policy is not: a real `Principal` runs through the real evaluator, so
 * these cases prove the rules that are the whole of this slice's safety — the organization is resolved
 * tenant-scoped BEFORE the org-wide `org.manage` authorize (a cross-tenant context is a 404 with no
 * write, the Known trap), the fixed allowlist is the boundary (an off-list key or an out-of-range/typed
 * value is a 400 with no write — no arbitrary key or value is stored), and both routes sit behind
 * `org.manage` (a caller without it is refused 403 both by `CapabilityGuard`, asserted through the route
 * metadata, and by the handler's real authorize).
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OWNER_USER = '00000000-0000-4000-8000-0000000000c1';
const MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';

/** An owner — the only internal role whose ceiling holds `org.manage`. */
function owner(): Principal {
  return {
    userId: OWNER_USER,
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

/** A workspace_admin — does not hold `org.manage`, so the write/read authorize denies. */
function orgAdmin(): Principal {
  return { ...owner(), role: 'workspace_admin' };
}

const context = {
  organizationId: ORG,
  membershipId: MEMBERSHIP,
} as unknown as TenantContext;

/**
 * An in-memory {@link PoliciesRepository}. `orgExists` controls the resolve-before-authorize step: a
 * cross-tenant context is modelled by constructing it `false`, exactly what the real tenant-scoped
 * resolve returns for an organization not in this tenant.
 */
class FakePoliciesRepository {
  row: OrgPolicyRow | undefined;
  upsertCalls = 0;

  constructor(private readonly orgExists = true) {}

  resolveOrganization(): Promise<{ readonly id: string } | undefined> {
    return Promise.resolve(this.orgExists ? { id: ORG } : undefined);
  }

  find(): Promise<OrgPolicyRow | undefined> {
    return Promise.resolve(this.row);
  }

  upsert(
    _r: unknown,
    _c: unknown,
    input: { policy: OrgPolicyValue; updatedBy: string },
  ): Promise<void> {
    this.upsertCalls += 1;
    this.row = {
      id: 'policy-1',
      organizationId: ORG,
      policyJson: input.policy,
      updatedBy: input.updatedBy,
      updatedAt: new Date('2026-09-27T00:00:00.000Z'),
      createdAt: new Date('2026-09-27T00:00:00.000Z'),
    };
    return Promise.resolve();
  }
}

function controllerWith(repo: FakePoliciesRepository): PoliciesController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new PoliciesController(database, repo as unknown as PoliciesRepository);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('PoliciesController (ADM access policies, x174)', () => {
  it('reads the defaults, updates fields, and reads the stored document back (the tenant-scoped round trip)', async () => {
    const repo = new FakePoliciesRepository();
    const controller = controllerWith(repo);

    const before = await controller.read(context, owner());
    expect(before.policy).toEqual(DEFAULT_POLICY);

    const after = await controller.update(context, owner(), {
      session_max_hours: 12,
      invite_domain_allowlist: ['Example.com', 'example.com'],
      guest_access_enabled: true,
    });
    expect(after.policy).toEqual({
      session_max_hours: 12,
      invite_domain_allowlist: ['example.com'], // lower-cased and de-duplicated
      guest_access_enabled: true,
    });
    expect(repo.upsertCalls).toBe(1);

    const reread = await controller.read(context, owner());
    expect(reread.policy.session_max_hours).toBe(12);
    expect(reread.policy.guest_access_enabled).toBe(true);
  });

  it('merges a partial update onto the stored document, leaving untouched fields as they were', async () => {
    const repo = new FakePoliciesRepository();
    const controller = controllerWith(repo);

    await controller.update(context, owner(), { session_max_hours: 8 });
    const after = await controller.update(context, owner(), { guest_access_enabled: true });

    expect(after.policy.session_max_hours).toBe(8); // preserved from the first write
    expect(after.policy.guest_access_enabled).toBe(true);
    expect(repo.upsertCalls).toBe(2);
  });

  it('accepts numeric/boolean values as strings, canonicalising them (typed and bounded)', async () => {
    const repo = new FakePoliciesRepository();
    const controller = controllerWith(repo);

    const after = await controller.update(context, owner(), {
      session_max_hours: '48',
      guest_access_enabled: 'false',
    });
    expect(after.policy.session_max_hours).toBe(48);
    expect(after.policy.guest_access_enabled).toBe(false);
  });

  it('400s an off-allowlist key, without a write (no arbitrary key is stored)', async () => {
    const repo = new FakePoliciesRepository();
    const controller = controllerWith(repo);

    await expectStatus(controller.update(context, owner(), { arbitrary_key: 'x' }), 400);
    expect(repo.upsertCalls).toBe(0);
  });

  it('400s an out-of-range or wrongly-typed value, without a write', async () => {
    const repo = new FakePoliciesRepository();
    const controller = controllerWith(repo);

    await expectStatus(controller.update(context, owner(), { session_max_hours: 0 }), 400);
    await expectStatus(controller.update(context, owner(), { session_max_hours: 100000 }), 400);
    await expectStatus(
      controller.update(context, owner(), { invite_domain_allowlist: ['not a domain'] }),
      400,
    );
    await expectStatus(
      controller.update(context, owner(), { invite_domain_allowlist: 'example.com' }),
      400,
    );
    await expectStatus(controller.update(context, owner(), { guest_access_enabled: 'maybe' }), 400);
    expect(repo.upsertCalls).toBe(0);
  });

  it('400s a non-object body, without a write', async () => {
    const repo = new FakePoliciesRepository();
    const controller = controllerWith(repo);

    await expectStatus(controller.update(context, owner(), null), 400);
    await expectStatus(controller.update(context, owner(), [1, 2]), 400);
    expect(repo.upsertCalls).toBe(0);
  });

  it('404s a cross-tenant organization, before authorize and before any write (Known trap)', async () => {
    const repo = new FakePoliciesRepository(false);
    const controller = controllerWith(repo);

    await expectStatus(controller.update(context, owner(), { session_max_hours: 12 }), 404);
    expect(repo.upsertCalls).toBe(0);
  });

  it('403s a caller without org.manage on the write, with the real authorize, and does not write', async () => {
    const repo = new FakePoliciesRepository();
    const controller = controllerWith(repo);

    await expectStatus(controller.update(context, orgAdmin(), { session_max_hours: 12 }), 403);
    expect(repo.upsertCalls).toBe(0);
  });

  it('403s a caller without org.manage on the read, with the real authorize', async () => {
    const repo = new FakePoliciesRepository();
    const controller = controllerWith(repo);

    await expectStatus(controller.read(context, orgAdmin()), 403);
  });

  it('guards both routes with org.manage, so a caller without it is refused 403 by CapabilityGuard', () => {
    for (const method of ['read', 'update'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        PoliciesController.prototype[method],
      );
      expect(capability).toBe('org.manage');
    }
  });
});
