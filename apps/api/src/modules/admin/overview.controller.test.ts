import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { AdminOverviewController } from './overview.controller.js';
import type {
  AdminOverviewRepository,
  OverviewAuditRow,
  OverviewMembershipRow,
  OverviewStorageRow,
} from './overview.repository.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * x175 — the org-wide admin overview roll-up. Database-free proofs over the module's fakes with the
 * **real** `authorize`: the three reads are ordinary tenant-scoped `SELECT`s (no schema change, so no
 * `.db.test.ts`), and the properties the controller owns are unit-provable:
 *   - the aggregation is correct and tenant-scoped — active/seats/offboarding counts and a summed,
 *     null-safe storage figure, with a cross-tenant row dropped before it contributes (Known-trap);
 *   - a principal `org.manage` refuses (a client — the capability is internal-only) is a 403, the
 *     org-level relation half of the route's `org.manage` ceiling, not a silently empty roll-up;
 *   - the route sits behind `org.manage` (asserted through the route metadata).
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';

const context = {
  organizationId: ORG,
  correlationId: 'correlation-0000-0000-0000-000000000001',
} as unknown as TenantContext;

/** An owner — the only internal role whose ceiling holds `org.manage`. */
function owner(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

/** A client — `org.manage` is internal-only, so the org-level authorize refuses. */
function client(): Principal {
  return {
    ...owner(),
    userId: 'user-0000-0000-0000-0000-000000000003',
    kind: 'client',
    role: 'client_admin',
    clientOrganizationId: 'client-org-0000-0000-000000000001',
    hasOrgWideScope: false,
  };
}

function controllerWith(
  memberships: readonly OverviewMembershipRow[],
  storage: readonly OverviewStorageRow[],
  auditWindow: readonly OverviewAuditRow[],
): AdminOverviewController {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const service = {
    listSeatMemberships: async () => memberships,
    listStorageCounter: async () => storage,
    listRecentAuditEvents: async () => auditWindow,
  } as unknown as AdminOverviewRepository;

  return new AdminOverviewController(database, service);
}

describe('AdminOverviewController.overviewMetrics (x175)', () => {
  it('rolls up members, seats, storage, audit and offboardings, dropping cross-tenant rows (Known-trap)', async () => {
    const memberships: OverviewMembershipRow[] = [
      { organizationId: ORG, membershipId: 'm1', status: 'active' },
      { organizationId: ORG, membershipId: 'm2', status: 'active' },
      { organizationId: ORG, membershipId: 'm3', status: 'invited' },
      { organizationId: ORG, membershipId: 'm4', status: 'suspended' },
      { organizationId: OTHER_ORG, membershipId: 'm9', status: 'active' }, // cross-tenant — dropped
    ];
    const storage: OverviewStorageRow[] = [
      { organizationId: ORG, usedBytes: 4096 },
      { organizationId: OTHER_ORG, usedBytes: 999999 }, // cross-tenant — dropped
    ];
    const auditWindow: OverviewAuditRow[] = [
      { organizationId: ORG, auditEventId: 'a1' },
      { organizationId: ORG, auditEventId: 'a2' },
      { organizationId: OTHER_ORG, auditEventId: 'a9' }, // cross-tenant — dropped
    ];

    const view = await controllerWith(memberships, storage, auditWindow).overviewMetrics(
      context,
      owner(),
    );

    expect(view).toEqual({
      activeMembers: 2,
      seatsUsed: 4,
      storageBytesUsed: 4096,
      auditWindowDays: 30,
      auditEventsWindow: 2,
      openOffboardings: 1,
      computedAt: view.computedAt,
    });
    expect(typeof view.computedAt).toBe('string');
  });

  it('reads an org with no storage counter as zero bytes', async () => {
    const view = await controllerWith(
      [{ organizationId: ORG, membershipId: 'm1', status: 'active' }],
      [], // no counter row
      [],
    ).overviewMetrics(context, owner());

    expect(view.storageBytesUsed).toBe(0);
  });

  it('refuses a principal without org.manage (a client — the capability is internal-only) with a 403', async () => {
    await expect(
      controllerWith(
        [{ organizationId: ORG, membershipId: 'm1', status: 'active' }],
        [{ organizationId: ORG, usedBytes: 1 }],
        [{ organizationId: ORG, auditEventId: 'a1' }],
      ).overviewMetrics(context, client()),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('guards the route with org.manage, so a caller without it is refused 403 by CapabilityGuard', () => {
    const capability = Reflect.getMetadata(
      REQUIRED_CAPABILITY,
      AdminOverviewController.prototype.overviewMetrics,
    );
    expect(capability).toBe('org.manage');
  });
});
