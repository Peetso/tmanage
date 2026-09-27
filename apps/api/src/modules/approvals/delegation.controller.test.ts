import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { ApiError } from '../../common/http/errors.js';
import { ApprovalDelegationController } from './delegation.controller.js';
import { ApprovalDelegationService } from './delegation.service.js';
import type { ApprovalDelegationRepository } from './delegation.repository.js';
import type { ApprovalDelegationRow, MembershipRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * Approval delegation (x300) controller/service refusal proofs over the module's fakes. The migration
 * and the tenant-scoped SQL round-trip are the DB suite's (the chain owns it); here the subject is the
 * security logic: the cross-tenant delegate is not-found with nothing written (never a 403 that would
 * confirm a foreign membership), self-delegation and an inverted window are refused before any write,
 * and the happy path records the caller's own delegation. The `approval.decide` route guard that
 * yields the 403 for a caller without the capability is the CapabilityGuard's, proven in the
 * permission-matrix suites.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-0000000000001';
const DELEGATOR = 'membership-0000-0000-0000-00000000001';
const DELEGATE = 'membership-0000-0000-0000-00000000002';
const FOREIGN = 'membership-0000-0000-0000-00000000009';

function principal(): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: DELEGATOR,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const context = { organizationId: ORG, userId: USER, membershipId: DELEGATOR } as TenantContext;

/** A controller over an in-memory store; only `DELEGATE` is an active membership of this tenant. */
function controllerWith(): {
  controller: ApprovalDelegationController;
  store: ApprovalDelegationRow[];
} {
  const store: ApprovalDelegationRow[] = [];
  const database = {
    read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repo = {
    findMembership: async (_r: unknown, _c: TenantContext, id: string) =>
      id === DELEGATE ? ({ id, organizationId: ORG, status: 'active' } as MembershipRow) : null,
    insert: async (
      _r: unknown,
      _c: TenantContext,
      input: {
        delegatorMembershipId: string;
        delegateMembershipId: string;
        startsAt: Date;
        endsAt: Date;
      },
    ) => {
      const row = {
        id: `delegation-${store.length + 1}`,
        organizationId: ORG,
        delegatorMembershipId: input.delegatorMembershipId,
        delegateMembershipId: input.delegateMembershipId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        createdAt: new Date('2026-09-27T00:00:00.000Z'),
      } as ApprovalDelegationRow;
      store.push(row);
      return row;
    },
  } as unknown as ApprovalDelegationRepository;

  const service = new ApprovalDelegationService(database, repo);
  return { controller: new ApprovalDelegationController(service), store };
}

const WINDOW = {
  startsAt: '2026-10-01T00:00:00.000Z',
  endsAt: '2026-10-08T00:00:00.000Z',
};

describe('ApprovalDelegationController.create', () => {
  it('records a delegation to an active member of the tenant', async () => {
    const { controller, store } = controllerWith();
    const view = await controller.create(context, principal(), {
      delegateMembershipId: DELEGATE,
      ...WINDOW,
    });
    expect(view.delegateMembershipId).toBe(DELEGATE);
    expect(store).toHaveLength(1);
  });

  it('is 404 with nothing written when the delegate is in another tenant', async () => {
    const { controller, store } = controllerWith();
    await expect(
      controller.create(context, principal(), { delegateMembershipId: FOREIGN, ...WINDOW }),
    ).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
    expect(store).toHaveLength(0);
  });

  it('refuses self-delegation before any write', async () => {
    const { controller, store } = controllerWith();
    await expect(
      controller.create(context, principal(), { delegateMembershipId: DELEGATOR, ...WINDOW }),
    ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
    expect(store).toHaveLength(0);
  });

  it('refuses an inverted window before any write', async () => {
    const { controller, store } = controllerWith();
    await expect(
      controller.create(context, principal(), {
        delegateMembershipId: DELEGATE,
        startsAt: WINDOW.endsAt,
        endsAt: WINDOW.startsAt,
      }),
    ).rejects.toMatchObject({ status: 400 } satisfies Partial<ApiError>);
    expect(store).toHaveLength(0);
  });
});
