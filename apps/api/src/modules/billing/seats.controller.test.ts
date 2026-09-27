import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { BillingSeatsController, BillingSeatsService } from './seats.controller.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { BillingSeatRow, MembershipRow } from '../../common/database/schema.js';

/**
 * x178 — the fast, database-free proof of billing seats (Billing module 19). It runs the controller
 * over an in-memory seat store and a fake membership lookup, with the **real** `authorize`: the
 * resolve-then-authorize order, the cross-tenant 404 (no write), the duplicate-active 409 and the
 * `org.manage` gate are the behaviours a wiring bug would break, and none needs MySQL. The composite
 * foreign key and the immutability trigger are proved against the real engine by the chain's DB
 * suite, not here (Peter's rule: no DB tests in-slice).
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const MEMBERSHIP = '01890000-0000-7000-8000-000000000011';

const context = { organizationId: ORG } as unknown as TenantContext;

/** An owner — the one internal role whose ceiling still holds `org.manage`. */
function owner(): Principal {
  return {
    userId: '01890000-0000-7000-8000-000000000001',
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

/** An in-memory seat store standing in for the repository, counting its writes. */
class FakeSeatsRepository {
  readonly seats: BillingSeatRow[] = [];
  creates = 0;
  releases = 0;
  constructor(private readonly memberships: readonly string[]) {}

  async findMembership(_r: unknown, _c: TenantContext, id: string) {
    return this.memberships.includes(id) ? ({ id, organizationId: ORG } as MembershipRow) : null;
  }

  async findById(_r: unknown, _c: TenantContext, seatId: string) {
    return this.seats.find((s) => s.id === seatId) ?? null;
  }

  async findActiveForMembership(_r: unknown, _c: TenantContext, membershipId: string) {
    return this.seats.find((s) => s.membershipId === membershipId && s.releasedAt === null) ?? null;
  }

  async listActive(_r: unknown, _c: TenantContext) {
    return this.seats.filter((s) => s.releasedAt === null);
  }

  async create(_r: unknown, _c: TenantContext, membershipId: string) {
    this.creates += 1;
    const row: BillingSeatRow = {
      id: `seat-${this.seats.length + 1}`,
      organizationId: ORG,
      membershipId,
      assignedAt: new Date(),
      releasedAt: null,
    };
    this.seats.push(row);
    return row;
  }

  async release(_r: unknown, _c: TenantContext, seatId: string) {
    const row = this.seats.find((s) => s.id === seatId && s.releasedAt === null);
    if (!row) return null;
    this.releases += 1;
    row.releasedAt = new Date();
    return row;
  }
}

function harness(memberships: readonly string[] = [MEMBERSHIP]) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repo = new FakeSeatsRepository(memberships);
  const service = new BillingSeatsService(
    database,
    repo as unknown as ConstructorParameters<typeof BillingSeatsService>[1],
  );
  return { controller: new BillingSeatsController(service), repo };
}

async function statusOf(work: () => Promise<unknown>): Promise<number> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
  throw new Error('expected the call to throw');
}

describe('BillingSeatsController', () => {
  let harnessed: ReturnType<typeof harness>;

  beforeEach(() => {
    harnessed = harness();
  });

  it('assigns, lists and reclaims a seat for an owner', async () => {
    const { controller } = harnessed;

    const assigned = await controller.assign(context, owner(), { membershipId: MEMBERSHIP });
    expect(assigned).toMatchObject({ membershipId: MEMBERSHIP, releasedAt: null });

    const listed = await controller.list(context, owner());
    expect(listed.activeCount).toBe(1);
    expect(listed.seats[0]).toMatchObject({ id: assigned.id });

    const released = await controller.release(context, owner(), assigned.id);
    expect(released.releasedAt).not.toBeNull();

    const after = await controller.list(context, owner());
    expect(after.activeCount).toBe(0);
  });

  it('refuses a duplicate active seat for a membership with 409', async () => {
    const { controller, repo } = harnessed;
    await controller.assign(context, owner(), { membershipId: MEMBERSHIP });
    const status = await statusOf(() =>
      controller.assign(context, owner(), { membershipId: MEMBERSHIP }),
    );
    expect(status).toBe(409);
    expect(repo.creates).toBe(1);
  });

  it('answers 404 and writes nothing when the membership is cross-tenant or absent', async () => {
    const { controller, repo } = harness([]); // no membership resolves in this tenant
    const status = await statusOf(() =>
      controller.assign(context, owner(), { membershipId: MEMBERSHIP }),
    );
    expect(status).toBe(404);
    expect(repo.creates).toBe(0);
  });

  it('answers 404 and writes nothing when the seat is cross-tenant or absent', async () => {
    const { controller, repo } = harnessed;
    const status = await statusOf(() => controller.release(context, owner(), 'seat-missing'));
    expect(status).toBe(404);
    expect(repo.releases).toBe(0);
  });

  it('refuses a principal without org.manage with 403 and writes nothing', async () => {
    const { controller, repo } = harnessed;
    const notManager: Principal = { ...owner(), role: 'org_admin' };
    const status = await statusOf(() =>
      controller.assign(context, notManager, { membershipId: MEMBERSHIP }),
    );
    expect(status).toBe(403);
    expect(repo.creates).toBe(0);
  });
});
