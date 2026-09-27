import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { PolicySimulateController } from './policy-simulate.controller.js';
import { PolicySimulateService } from './policy-simulate.service.js';
import type { PolicySimulateReads, SimulatedMember } from './policy-simulate.repository.js';
import type { PrincipalRepository } from '../tenancy/principal.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * Access-policy simulation (x196) over fakes, with the **real** `authorize`.
 *
 * The tenant-scoped reads (organization existence, the member row) and the project-scope read are faked,
 * but the decision is not: a real member `Principal` is assembled and run through the real evaluator, so
 * these cases prove the whole of this slice's safety. The simulator must *mirror* the live decision — an
 * owner may `org.manage`, an ordinary member may not — and it must not leak or lie across a tenant: the
 * organization is resolved before the caller's `org.manage` authorize (a cross-tenant context is a 404),
 * an unknown capability is a 400, a member absent from this tenant is a 404, and a caller without
 * `org.manage` is refused 403 both by `CapabilityGuard` (asserted through the route metadata) and by the
 * handler's real authorize.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const CALLER_USER = '00000000-0000-4000-8000-0000000000c1';
const CALLER_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';
const CORRELATION = '00000000-0000-4000-8000-0000000000f1';
const TARGET_USER = '00000000-0000-4000-8000-0000000000b2';
const TARGET_MEMBER = '00000000-0000-4000-8000-0000000000b3';

/** An owner — the only internal role whose ceiling holds `org.manage`. Used as the acting caller. */
function owner(): Principal {
  return {
    userId: CALLER_USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: CALLER_MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

/** An org_admin — holds every capability except `org.manage`, so the caller authorize denies. */
function orgAdmin(): Principal {
  return { ...owner(), role: 'org_admin' };
}

const context = {
  organizationId: ORG,
  userId: CALLER_USER,
  membershipId: CALLER_MEMBERSHIP,
  correlationId: CORRELATION,
} as unknown as TenantContext;

/** A seeded member row, active by default, with the role under simulation. */
function member(role: string, overrides: Partial<SimulatedMember> = {}): SimulatedMember {
  return {
    userId: TARGET_USER,
    role,
    status: 'active',
    hasOrgWideScope: role === 'owner' || role === 'org_admin',
    workspaceScopeId: null,
    ...overrides,
  };
}

/** In-memory reads. `orgExists` models the cross-tenant organization; `row` the resolved member. */
class FakeReads implements PolicySimulateReads {
  constructor(
    private readonly row: SimulatedMember | undefined,
    private readonly orgExists = true,
  ) {}

  organizationExists(): Promise<boolean> {
    return Promise.resolve(this.orgExists);
  }

  findMember(): Promise<SimulatedMember | undefined> {
    return Promise.resolve(this.row);
  }
}

/** A project-scope that returns no projects — the member's relation set is not what these cases turn on. */
const fakePrincipals = {
  projectScope: () => Promise.resolve([] as readonly string[]),
} as unknown as PrincipalRepository;

function controllerWith(reads: FakeReads): PolicySimulateController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new PolicySimulateController(database, new PolicySimulateService(reads, fakePrincipals));
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('PolicySimulateController (ADM policy simulation, x196)', () => {
  it('mirrors the live evaluator: allows a capability the seeded role holds, and names the deciding rule', async () => {
    const controller = controllerWith(new FakeReads(member('owner')));

    const view = await controller.simulate(context, owner(), {
      memberId: TARGET_MEMBER,
      capability: 'org.manage',
    });

    expect(view.result.allowed).toBe(true);
    expect(view.result.role).toBe('owner');
    expect(view.result.decidingRule).toBe('role:owner');
    expect(view.result.denialCode).toBeNull();
  });

  it('mirrors the live evaluator: denies a capability outside the seeded role, and reports the code', async () => {
    const controller = controllerWith(new FakeReads(member('member')));

    const view = await controller.simulate(context, owner(), {
      memberId: TARGET_MEMBER,
      capability: 'org.manage',
    });

    expect(view.result.allowed).toBe(false);
    expect(view.result.denialCode).toBe('capability_not_in_role_ceiling');
    expect(view.result.decidingRule).toBe('capability_not_in_role_ceiling');
  });

  it('denies a suspended member with membership_inactive, matching the evaluator first check', async () => {
    const controller = controllerWith(new FakeReads(member('owner', { status: 'suspended' })));

    const view = await controller.simulate(context, owner(), {
      memberId: TARGET_MEMBER,
      capability: 'org.manage',
    });

    expect(view.result.allowed).toBe(false);
    expect(view.result.denialCode).toBe('membership_inactive');
  });

  it('400s an unknown capability, without simulating', async () => {
    const controller = controllerWith(new FakeReads(member('owner')));

    await expectStatus(
      controller.simulate(context, owner(), {
        memberId: TARGET_MEMBER,
        capability: 'not.a.capability',
      }),
      400,
    );
  });

  it('400s a body missing the member id or the capability', async () => {
    const controller = controllerWith(new FakeReads(member('owner')));

    await expectStatus(controller.simulate(context, owner(), { capability: 'org.manage' }), 400);
    await expectStatus(controller.simulate(context, owner(), { memberId: TARGET_MEMBER }), 400);
    await expectStatus(controller.simulate(context, owner(), null), 400);
  });

  it('404s a member absent from this tenant (a cross-tenant member is indistinguishable from unknown)', async () => {
    const controller = controllerWith(new FakeReads(undefined));

    await expectStatus(
      controller.simulate(context, owner(), { memberId: TARGET_MEMBER, capability: 'org.manage' }),
      404,
    );
  });

  it('404s a cross-tenant organization before authorize and before any compute (Known trap)', async () => {
    const controller = controllerWith(new FakeReads(member('owner'), false));

    await expectStatus(
      controller.simulate(context, owner(), { memberId: TARGET_MEMBER, capability: 'org.manage' }),
      404,
    );
  });

  it('403s a caller without org.manage, with the real authorize, and does not simulate', async () => {
    const controller = controllerWith(new FakeReads(member('owner')));

    await expectStatus(
      controller.simulate(context, orgAdmin(), {
        memberId: TARGET_MEMBER,
        capability: 'org.manage',
      }),
      403,
    );
  });

  it('guards the route with org.manage, so a caller without it is refused 403 by CapabilityGuard', () => {
    const capability = Reflect.getMetadata(
      REQUIRED_CAPABILITY,
      PolicySimulateController.prototype.simulate,
    );
    expect(capability).toBe('org.manage');
  });
});
