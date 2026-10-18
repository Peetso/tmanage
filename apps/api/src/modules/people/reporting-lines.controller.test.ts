import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { ReportingLinesController } from './reporting-lines.controller.js';
import type {
  ReportingLinesRepository,
  SetReportingLineInput,
} from './reporting-lines.repository.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MemberReportingLineRow, MembershipRow } from '../../common/database/schema.js';

/**
 * People reporting lines / org chart (x217) controller proofs, database-free over fakes with the
 * *real* `authorize`. The migration, the upsert's SQL round-trip and the tenant guard are the chain's
 * DB suite, not here; this file proves the controller's own security logic: the Known-trap 404 for a
 * cross-tenant member/manager with no write, the self-manager and cycle 400s with no write, the
 * org-scoped authorize (org.manage to set, work.read to read), and set/clear/org-chart shapes.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';
const A = 'membership-0000-0000-0000-00000000000a';
const B = 'membership-0000-0000-0000-00000000000b';
const FOREIGN = 'membership-0000-0000-0000-0000000000ff';

function principal(role: Principal['role'], kind: Principal['kind'] = 'internal'): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind,
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: kind === 'client' ? 'client-org-0000-0000-000000000001' : null,
    projectIds: [PROJECT],
    hasOrgWideScope: true,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function member(id: string, organizationId: string): MembershipRow {
  return {
    id,
    organizationId,
    userId: 'user-0000-0000-0000-0000-0000000000aa',
    role: 'member',
    status: 'active',
    hasOrgWideScope: false,
    workspaceScopeId: null,
    version: 1,
    policyVersion: 1,
    createdAt: new Date('2026-09-26T10:00:00.000Z'),
    updatedAt: new Date('2026-09-26T10:00:00.000Z'),
  } as unknown as MembershipRow;
}

/**
 * A controller over in-memory stores. `setCalls`/`clearCalls` record every write so a test can assert
 * none happened. The membership fake is tenant-scoped like the real repository: a member of another org
 * resolves to null, which the controller turns into a 404 before any write. Seed lines express an
 * existing chain for cycle tests.
 */
function controllerWith(
  members: readonly MembershipRow[],
  seed: readonly { member: string; manager: string }[] = [],
) {
  const store = new Map<string, MemberReportingLineRow>();
  for (const line of seed) {
    store.set(`${ORG}:${line.member}`, {
      id: `line-${line.member}`,
      organizationId: ORG,
      memberId: line.member,
      managerMemberId: line.manager,
      createdAt: new Date('2026-09-26T10:00:00.000Z'),
      updatedAt: new Date('2026-09-26T10:00:00.000Z'),
    } as unknown as MemberReportingLineRow);
  }
  const setCalls: SetReportingLineInput[] = [];
  const clearCalls: string[] = [];

  const database = {
    read: async (_ctx: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
    transaction: async (_ctx: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const memberships = {
    findById: async (_runner: unknown, ctx: TenantContext, id: string) =>
      members.find((m) => m.id === id && m.organizationId === ctx.organizationId) ?? null,
  } as unknown as MembershipsRepository;

  const reportingLines = {
    findByMember: async (_runner: unknown, ctx: TenantContext, memberId: string) =>
      store.get(`${ctx.organizationId}:${memberId}`) ?? null,
    listAll: async (_runner: unknown, ctx: TenantContext) =>
      [...store.values()].filter((r) => r.organizationId === ctx.organizationId),
    set: async (_runner: unknown, ctx: TenantContext, input: SetReportingLineInput) => {
      setCalls.push(input);
      const row = {
        id: `line-${input.memberId}`,
        organizationId: ctx.organizationId,
        memberId: input.memberId,
        managerMemberId: input.managerMemberId,
        createdAt: new Date('2026-09-26T10:00:00.000Z'),
        updatedAt: new Date('2026-09-26T10:00:00.000Z'),
      } as unknown as MemberReportingLineRow;
      store.set(`${ctx.organizationId}:${input.memberId}`, row);
      return row;
    },
    clear: async (_runner: unknown, ctx: TenantContext, memberId: string) => {
      clearCalls.push(memberId);
      store.delete(`${ctx.organizationId}:${memberId}`);
    },
  } as unknown as ReportingLinesRepository;

  return {
    controller: new ReportingLinesController(database, reportingLines, memberships),
    setCalls,
    clearCalls,
  };
}

describe('ReportingLinesController', () => {
  it('sets a manager, reads it back, and lists it in the org chart', async () => {
    const { controller, setCalls } = controllerWith([member(A, ORG), member(B, ORG)]);
    const actor = principal('owner');

    const set = await controller.set(context, actor, A, { managerMembershipId: B });
    expect(set).toEqual({ membershipId: A, managerMembershipId: B });
    expect(set).not.toHaveProperty('organizationId');
    expect(setCalls).toEqual([{ memberId: A, managerMemberId: B }]);

    const read = await controller.read(context, actor, A);
    expect(read.reportingLine).toEqual({ membershipId: A, managerMembershipId: B });

    const chart = await controller.orgChart(context, actor);
    expect(chart.lines).toContainEqual({ membershipId: A, managerMembershipId: B });
  });

  it('clears a manager and reads null', async () => {
    const { controller, clearCalls } = controllerWith(
      [member(A, ORG), member(B, ORG)],
      [{ member: A, manager: B }],
    );
    const cleared = await controller.set(context, principal('owner'), A, {
      managerMembershipId: null,
    });
    expect(cleared).toEqual({ membershipId: A, managerMembershipId: null });
    expect(clearCalls).toEqual([A]);

    const read = await controller.read(context, principal('owner'), A);
    expect(read.reportingLine).toEqual({ membershipId: A, managerMembershipId: null });
  });

  it('rejects a self-manager with 400 and writes nothing', async () => {
    const { controller, setCalls } = controllerWith([member(A, ORG)]);
    await expect(
      controller.set(context, principal('owner'), A, { managerMembershipId: A }),
    ).rejects.toMatchObject({ status: 400 });
    expect(setCalls).toEqual([]);
  });

  it('rejects a cycle with 400 and writes nothing', async () => {
    // Existing chain B -> A. Setting A -> B would close the loop A -> B -> A.
    const { controller, setCalls } = controllerWith(
      [member(A, ORG), member(B, ORG)],
      [{ member: B, manager: A }],
    );
    await expect(
      controller.set(context, principal('owner'), A, { managerMembershipId: B }),
    ).rejects.toMatchObject({ status: 400 });
    expect(setCalls).toEqual([]);
  });

  it('returns 404 for a cross-tenant manager id and writes nothing', async () => {
    const { controller, setCalls } = controllerWith([member(A, ORG), member(FOREIGN, OTHER_ORG)]);
    await expect(
      controller.set(context, principal('owner'), A, { managerMembershipId: FOREIGN }),
    ).rejects.toMatchObject({ status: 404 });
    expect(setCalls).toEqual([]);
  });

  it('returns 404 for a cross-tenant member id and writes nothing', async () => {
    const { controller, setCalls } = controllerWith([member(FOREIGN, OTHER_ORG), member(B, ORG)]);
    await expect(
      controller.set(context, principal('owner'), FOREIGN, { managerMembershipId: B }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(setCalls).toEqual([]);
  });

  it('refuses to set a manager without org.manage (403) and writes nothing', async () => {
    // `workspace_admin` does not hold `org.manage`, so the org-scoped authorize denies.
    const { controller, setCalls } = controllerWith([member(A, ORG), member(B, ORG)]);
    await expect(
      controller.set(context, principal('workspace_admin'), A, { managerMembershipId: B }),
    ).rejects.toMatchObject({ status: 403 });
    expect(setCalls).toEqual([]);
  });

  it('refuses to read the org chart without work.read (403)', async () => {
    const { controller } = controllerWith([member(A, ORG)]);
    await expect(
      controller.orgChart(context, principal('client_member', 'client')),
    ).rejects.toMatchObject({ status: 403 });
  });
});
