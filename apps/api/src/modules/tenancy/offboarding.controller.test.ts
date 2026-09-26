import { describe, expect, it } from 'vitest';
import { OFFBOARDING_NEVER_AUTO_RESTORES_ACCESS } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { OffboardingService } from './offboarding.service.js';
import type { MembershipsRepository } from './memberships.repository.js';
import type { ProjectMembershipsRepository } from '../projects/project-memberships.repository.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MembershipRow } from '../../common/database/schema.js';

/**
 * ADM-12/13 (x121) offboarding proofs, database-free over the module's fakes with the **real**
 * `authorize()` and the **real** service guards. The migration is none (no schema change) and the
 * tenant-scoped SQL round-trip is covered by the tenant-isolation chain; here the subject is the
 * security substance — the capability gate, the Known-trap resolve-before-write (cross-tenant id →
 * 404, no write, never 500), and the three exclusions (self, last administrator, already terminal),
 * each proven to leave no write and no second audit row.
 */

const ORG = 'aaaaaaaa-0000-7000-8000-000000000001';
const CALLER_USER = 'bbbbbbbb-0000-7000-8000-000000000001';
const CALLER_MEMBERSHIP = 'cccccccc-0000-7000-8000-000000000001';
const TARGET_MEMBERSHIP = 'dddddddd-0000-7000-8000-000000000001';
const TARGET_USER = 'eeeeeeee-0000-7000-8000-000000000001';
const UNKNOWN_USER = 'ffffffff-0000-7000-8000-0000000000ff';

const context = {
  organizationId: ORG,
  userId: CALLER_USER,
  membershipId: CALLER_MEMBERSHIP,
} as unknown as TenantContext;

/** An org-wide administrator who holds `member.offboard`. */
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

/** A plain member, who does not hold `member.offboard`. */
function member(): Principal {
  return { ...owner(), role: 'member', hasOrgWideScope: false };
}

function membershipRow(overrides: Partial<MembershipRow> = {}): MembershipRow {
  return {
    id: TARGET_MEMBERSHIP,
    organizationId: ORG,
    userId: TARGET_USER,
    role: 'member',
    status: 'active',
    version: 1,
    hasOrgWideScope: false,
    workspaceScopeId: null,
    policyVersion: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as MembershipRow;
}

interface AuditCall {
  readonly action: string;
  readonly result: string;
  readonly objectId: string | null;
}

/**
 * A service over an in-memory membership store.
 *
 * `otherAdmins` is what `countActiveHoldersOfRoles` returns — the number of *other* active
 * `org.manage` holders — so a test sets it to 0 to make the target the last administrator.
 * `transitions` and `audits` record every write attempt, so a refusal can be proven to have made
 * none.
 */
function serviceWith(
  seed: MembershipRow | null,
  options: { readonly otherAdmins?: number } = {},
): {
  service: OffboardingService;
  transitions: MembershipRow[];
  audits: AuditCall[];
} {
  // Keyed by user id: the routes resolve a member by `(organization_id, user_id)`, so the fake
  // `findByUserId` is the tenant-scoped lookup, and an unknown user id stands in for one that is
  // unknown or belongs to another tenant.
  const store = new Map<string, MembershipRow>();
  if (seed) store.set(seed.userId, seed);
  const transitions: MembershipRow[] = [];
  const audits: AuditCall[] = [];

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const memberships = {
    findByUserId: async (_runner: unknown, _ctx: unknown, userId: string) =>
      store.get(userId) ?? null,
    countActiveHoldersOfRoles: async () => options.otherAdmins ?? 5,
    transitionStatus: async (
      _runner: unknown,
      _ctx: unknown,
      id: string,
      _expectedVersion: number,
      to: MembershipRow['status'],
    ) => {
      const current = [...store.values()].find((row) => row.id === id);
      if (!current) throw new Error('missing');
      const next = { ...current, status: to, version: current.version + 1 };
      store.set(next.userId, next);
      transitions.push(next);
      return next;
    },
  } as unknown as MembershipsRepository;

  const projectMemberships = {
    countByUser: async () => 3,
  } as unknown as ProjectMembershipsRepository;

  const workItems = {
    countOwnedByUser: async () => 7,
  } as unknown as WorkItemsRepository;

  const audit = {
    record: async (
      _runner: unknown,
      _ctx: unknown,
      input: { action: string; result: string; objectId: string | null },
    ) => {
      audits.push({ action: input.action, result: input.result, objectId: input.objectId });
      return {} as unknown;
    },
  } as unknown as AuditService;

  return {
    service: new OffboardingService(database, memberships, audit, projectMemberships, workItems),
    transitions,
    audits,
  };
}

describe('OffboardingService', () => {
  it('previews impact, then offboards, tenant-scoped (round-trip)', async () => {
    const { service, transitions, audits } = serviceWith(membershipRow());

    const impact = await service.impact(context, owner(), TARGET_USER);
    expect(impact.membershipId).toBe(TARGET_MEMBERSHIP);
    expect(impact.userId).toBe(TARGET_USER);
    expect(impact.projectMembershipCount).toBe(3);
    expect(impact.ownedWorkItemCount).toBe(7);
    expect(impact.offboardable).toBe(true);
    // The wire projection never echoes the tenant id.
    expect(JSON.stringify(impact)).not.toContain(ORG);
    // A preview mutates nothing.
    expect(transitions).toHaveLength(0);
    expect(audits).toHaveLength(0);

    const result = await service.offboard(context, owner(), TARGET_USER);
    expect(result.status).toBe('offboarded');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.status).toBe('offboarded');
    // Exactly one audit row, and only for the real transition.
    expect(audits).toEqual([
      { action: 'membership.offboarded', result: 'allowed', objectId: TARGET_MEMBERSHIP },
    ]);
  });

  it('returns 404 with no write for an unknown or cross-tenant membership id (Known trap)', async () => {
    const { service, transitions, audits } = serviceWith(membershipRow());

    await expect(service.impact(context, owner(), UNKNOWN_USER)).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.offboard(context, owner(), UNKNOWN_USER)).rejects.toMatchObject({
      status: 404,
    });
    expect(transitions).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('refuses a caller without member.offboard with 403 (real authorize)', async () => {
    const { service, transitions, audits } = serviceWith(membershipRow());

    await expect(service.impact(context, member(), TARGET_USER)).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.offboard(context, member(), TARGET_USER)).rejects.toMatchObject({
      status: 403,
    });
    expect(transitions).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('refuses a caller offboarding themselves with 403 and no write', async () => {
    // The target IS the caller's own membership.
    const { service, transitions, audits } = serviceWith(
      membershipRow({ id: CALLER_MEMBERSHIP, userId: CALLER_USER, role: 'owner' }),
    );

    await expect(service.offboard(context, owner(), CALLER_USER)).rejects.toMatchObject({
      status: 403,
    });
    expect(transitions).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('refuses offboarding the last administrator with 403 and no write', async () => {
    const { service, transitions, audits } = serviceWith(membershipRow({ role: 'owner' }), {
      otherAdmins: 0,
    });

    await expect(service.offboard(context, owner(), TARGET_USER)).rejects.toMatchObject({
      status: 403,
    });
    expect(transitions).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('offboards an owner when another administrator remains', async () => {
    const { service, transitions, audits } = serviceWith(membershipRow({ role: 'owner' }), {
      otherAdmins: 1,
    });

    const result = await service.offboard(context, owner(), TARGET_USER);
    expect(result.status).toBe('offboarded');
    expect(transitions).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it('refuses re-offboarding a terminal member with 409, writing no second audit row', async () => {
    const { service, transitions, audits } = serviceWith(membershipRow({ status: 'offboarded' }));

    // Impact still reads, and reports the member is no longer offboardable.
    const impact = await service.impact(context, owner(), TARGET_USER);
    expect(impact.offboardable).toBe(false);

    await expect(service.offboard(context, owner(), TARGET_USER)).rejects.toMatchObject({
      status: 409,
    });
    expect(transitions).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('never auto-restores access — offboarding is a one-way door', () => {
    // The storage terminal state and the domain invariant agree: there is no path back.
    expect(OFFBOARDING_NEVER_AUTO_RESTORES_ACCESS).toBe(true);
  });
});
