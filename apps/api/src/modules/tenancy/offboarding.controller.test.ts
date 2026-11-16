import { describe, expect, it, vi } from 'vitest';
import { customRoleKey, OFFBOARDING_NEVER_AUTO_RESTORES_ACCESS } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { OffboardingService } from './offboarding.service.js';
import type { MembershipsRepository } from './memberships.repository.js';
import type { ProjectMembershipsRepository } from '../projects/project-memberships.repository.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MembershipRow } from '../../common/database/schema.js';
import type { InvitationsRepository } from './invitations.repository.js';
import type { MemberBulkRoleRepository } from './member-bulk-role.repository.js';
import type { StorageHoldsHook } from '../storage-root/storage-holds.js';

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
/** A custom role `{member.offboard, work.read}` (a delegated offboarder). */
const CUSTOM_ROLE = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

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
  readonly metadata: Record<string, unknown> | undefined;
}

/**
 * A service over an in-memory membership store.
 *
 * `otherAdmins` is what `countActiveHoldersOfRoles` returns — the number of *other* active
 * `org.manage` holders — so a test sets it to 0 to make the target the last administrator.
 * `otherOwners` is what it returns when asked about the `owner` role alone (ACCOUNT item 3); it
 * defaults to `otherAdmins`.
 * `transitions` and `audits` record every write attempt, so a refusal can be proven to have made
 * none.
 */
function serviceWith(
  seed: MembershipRow | null,
  options: {
    readonly otherAdmins?: number;
    readonly otherOwners?: number;
    readonly storageHolds?: StorageHoldsHook;
  } = {},
): {
  service: OffboardingService;
  transitions: MembershipRow[];
  audits: AuditCall[];
  projectRemovals: string[];
  workClears: string[];
  invitationRevocations: string[];
} {
  // Keyed by user id: the routes resolve a member by `(organization_id, user_id)`, so the fake
  // `findByUserId` is the tenant-scoped lookup, and an unknown user id stands in for one that is
  // unknown or belongs to another tenant.
  const store = new Map<string, MembershipRow>();
  if (seed) store.set(seed.userId, seed);
  const transitions: MembershipRow[] = [];
  const audits: AuditCall[] = [];
  // Every user id offboarding revokes access and work for, so a refusal can be proven to have
  // removed no project membership and cleared no owned work.
  const projectRemovals: string[] = [];
  const workClears: string[] = [];
  const invitationRevocations: string[] = [];

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const memberships = {
    findByUserId: async (_runner: unknown, _ctx: unknown, userId: string) =>
      store.get(userId) ?? null,
    countActiveHoldersOfRoles: async (_runner: unknown, _ctx: unknown, roles: readonly string[]) =>
      roles.length === 1 && roles[0] === 'owner'
        ? (options.otherOwners ?? options.otherAdmins ?? 5)
        : (options.otherAdmins ?? 5),
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
    removeAllForUser: async (_runner: unknown, _ctx: unknown, userId: string) => {
      projectRemovals.push(userId);
      return 3;
    },
  } as unknown as ProjectMembershipsRepository;

  const workItems = {
    countOwnedByUser: async () => 7,
    clearOwnerForUser: async (_runner: unknown, _ctx: unknown, ownerUserId: string) => {
      workClears.push(ownerUserId);
      return 7;
    },
  } as unknown as WorkItemsRepository;

  const audit = {
    record: async (
      _runner: unknown,
      _ctx: unknown,
      input: {
        action: string;
        result: string;
        objectId: string | null;
        metadata?: Record<string, unknown>;
      },
    ) => {
      audits.push({
        action: input.action,
        result: input.result,
        objectId: input.objectId,
        metadata: input.metadata,
      });
      return {} as unknown;
    },
  } as unknown as AuditService;

  const invitations = {
    revokePendingIssuedBy: async (_runner: unknown, _ctx: unknown, userId: string) => {
      invitationRevocations.push(userId);
      return 2;
    },
  } as unknown as InvitationsRepository;
  const customRoles = {
    findRoleById: async (_runner: unknown, _ctx: unknown, id: string) =>
      id === CUSTOM_ROLE ? { id, capabilitiesJson: '["member.offboard","work.read"]' } : undefined,
  } as unknown as MemberBulkRoleRepository;

  return {
    service: new OffboardingService(
      database,
      memberships,
      audit,
      projectMemberships,
      workItems,
      invitations,
      customRoles,
      options.storageHolds ?? null,
    ),
    transitions,
    audits,
    projectRemovals,
    workClears,
    invitationRevocations,
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
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('membership.offboarded');
    expect(audits[0]?.result).toBe('allowed');
    expect(audits[0]?.objectId).toBe(TARGET_MEMBERSHIP);
  });

  it('51-17: says which company storage the leaver holds, and announces it inside the leave', async () => {
    const heldBy = vi.fn(async (_runner: unknown, ctx: TenantContext, userId: string) =>
      ctx.organizationId === ORG && userId === TARGET_USER
        ? [{ connectionId: 'conn-1', provider: 'google_drive' as const }]
        : [],
    );
    const announceLeft = vi.fn(async () => undefined);
    const storageHolds = { heldBy, announceLeft } as unknown as StorageHoldsHook;
    const { service } = serviceWith(membershipRow(), { storageHolds });

    const impact = await service.impact(context, owner(), TARGET_USER);
    expect(impact.storageConnections).toEqual(['google_drive']);
    expect(announceLeft).not.toHaveBeenCalled();

    const result = await service.offboard(context, owner(), TARGET_USER);
    expect(result.storageHandoverRequired).toEqual(['google_drive']);
    expect(announceLeft).toHaveBeenCalledWith(
      expect.anything(),
      context,
      [{ connectionId: 'conn-1', provider: 'google_drive' }],
      `${TARGET_MEMBERSHIP}:2`,
    );
  });

  it('51-17: a refused offboard announces nothing', async () => {
    const announceLeft = vi.fn(async () => undefined);
    const storageHolds = {
      heldBy: vi.fn(async () => [{ connectionId: 'conn-1', provider: 'onedrive' as const }]),
      announceLeft,
    } as unknown as StorageHoldsHook;
    const { service } = serviceWith(membershipRow({ role: 'owner' }), {
      otherAdmins: 0,
      storageHolds,
    });
    await expect(service.offboard(context, owner(), TARGET_USER)).rejects.toMatchObject({
      status: 403,
    });
    expect(announceLeft).not.toHaveBeenCalled();
  });

  it('revokes project access and releases owned work in the same transaction (ADM-06, ADM-07)', async () => {
    const { service, projectRemovals, workClears, audits } = serviceWith(membershipRow());

    await service.offboard(context, owner(), TARGET_USER);

    // Both run, keyed by the target's user id, not the caller's.
    expect(projectRemovals).toEqual([TARGET_USER]);
    expect(workClears).toEqual([TARGET_USER]);
    // The counts are recorded on the one audit row, so "who revoked what" is answerable.
    expect(audits[0]?.metadata).toMatchObject({
      target_user_id: TARGET_USER,
      project_memberships_removed: 3,
      owned_work_items_cleared: 7,
    });
  });

  it('removes no project membership and clears no work when the offboard is refused', async () => {
    // Re-offboarding a terminal member is refused before the transaction (Guard 2).
    const { service, projectRemovals, workClears } = serviceWith(
      membershipRow({ status: 'offboarded' }),
    );

    await expect(service.offboard(context, owner(), TARGET_USER)).rejects.toMatchObject({
      status: 409,
    });
    expect(projectRemovals).toHaveLength(0);
    expect(workClears).toHaveLength(0);
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

  it('offboards an owner when another owner remains', async () => {
    const { service, transitions, audits } = serviceWith(membershipRow({ role: 'owner' }), {
      otherAdmins: 1,
      otherOwners: 1,
    });

    const result = await service.offboard(context, owner(), TARGET_USER);
    expect(result.status).toBe('offboarded');
    expect(transitions).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it('ACCOUNT item 3: refuses removing the last owner while an organization admin remains', async () => {
    // An org admin holds org.manage, so the administrator count alone let the last owner go and
    // left the organization with nobody who owns it.
    const { service, transitions, audits } = serviceWith(membershipRow({ role: 'owner' }), {
      otherAdmins: 1,
      otherOwners: 0,
    });

    await expect(service.offboard(context, owner(), TARGET_USER)).rejects.toMatchObject({
      status: 403,
      auditCode: 'offboard_last_owner',
    });
    expect(transitions).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('refuses an organization admin offboarding an owner (CQ-06), with no write', async () => {
    const { service, transitions } = serviceWith(membershipRow({ role: 'owner' }), {
      otherAdmins: 2,
    });

    await expect(
      service.offboard(context, { ...owner(), role: 'org_admin' }, TARGET_USER),
    ).rejects.toMatchObject({ status: 403, auditCode: 'offboard_owner' });
    expect(transitions).toHaveLength(0);
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

  it('F06: withdraws the pending invitations the member issued, in the offboard transaction', async () => {
    const { service, invitationRevocations, audits } = serviceWith(
      membershipRow({ role: 'org_admin' }),
    );

    await service.offboard(context, owner(), TARGET_USER);

    expect(invitationRevocations).toEqual([TARGET_USER]);
    expect(audits[0]?.metadata).toMatchObject({ invitations_revoked: 2 });
  });

  it('F23: a workspace admin cannot offboard or preview an organization admin (403, no write)', async () => {
    const { service, transitions, audits, invitationRevocations } = serviceWith(
      membershipRow({ role: 'org_admin' }),
    );
    const workspaceAdmin = { ...owner(), role: 'workspace_admin' } as Principal;

    await expect(service.offboard(context, workspaceAdmin, TARGET_USER)).rejects.toMatchObject({
      status: 403,
      auditCode: 'offboard_admin',
    });
    await expect(service.impact(context, workspaceAdmin, TARGET_USER)).rejects.toMatchObject({
      status: 403,
    });
    expect(transitions).toHaveLength(0);
    expect(audits).toHaveLength(0);
    expect(invitationRevocations).toHaveLength(0);
  });

  it('F23: a custom member.offboard role cannot offboard a workspace admin (403, no write)', async () => {
    const { service, transitions } = serviceWith(membershipRow({ role: 'workspace_admin' }));
    const delegated = {
      ...owner(),
      role: customRoleKey(CUSTOM_ROLE, ['member.offboard', 'work.read']),
      hasOrgWideScope: false,
    } as Principal;

    await expect(service.offboard(context, delegated, TARGET_USER)).rejects.toMatchObject({
      status: 403,
      auditCode: 'offboard_ceiling',
    });
    expect(transitions).toHaveLength(0);
  });

  it('F23: a custom member.offboard role may offboard a holder of a narrower custom role', async () => {
    const { service } = serviceWith(membershipRow({ role: CUSTOM_ROLE }));
    const delegated = {
      ...owner(),
      role: customRoleKey(CUSTOM_ROLE, ['member.offboard', 'work.read']),
      hasOrgWideScope: false,
    } as Principal;

    const result = await service.offboard(context, delegated, TARGET_USER);
    expect(result.status).toBe('offboarded');
  });

  it('F23: an organization admin still offboards a member (200)', async () => {
    const { service } = serviceWith(membershipRow({ role: 'member' }));

    const result = await service.offboard(context, { ...owner(), role: 'org_admin' }, TARGET_USER);
    expect(result.status).toBe('offboarded');
  });

  it('never auto-restores access — offboarding is a one-way door', () => {
    // The storage terminal state and the domain invariant agree: there is no path back.
    expect(OFFBOARDING_NEVER_AUTO_RESTORES_ACCESS).toBe(true);
  });
});
