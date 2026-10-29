import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { customRoleKey } from '@tmanage/domain';
import type { Capability, PermissionOverrides, Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { ensureRequestState } from '../../common/http/request-state.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { MemberBulkRoleRepository } from './member-bulk-role.repository.js';
import { MembershipOverridesController } from './membership-overrides.controller.js';
import type {
  MembershipOverrideRecord,
  MembershipOverridesRepository,
  OverrideMember,
} from './membership-overrides.repository.js';
import type { ResolvedMembership } from './membership-resolver.repository.js';
import type { ValidOverride } from './override-ceiling.js';

/** platform-admin v2 · PA-01 — per-member overrides, the preview and `me` (SPEC §3.3). */

const ORG = '0199dd00-0000-7000-8000-0000000000c1';
const CALLER_MEMBERSHIP = '0199dd00-0000-7000-8000-0000000000b1';
const TARGET = '0199dd00-0000-7000-8000-0000000000b2';
const OWNER_SEAT = '0199dd00-0000-7000-8000-0000000000b3';
const FOREIGN = '0199dd00-0000-7000-8000-0000000000b9';
const PROJECT = '0199dd00-0000-7000-8000-000000000101';

function principal(role: string, over: Partial<Principal> = {}): Principal {
  return {
    userId: '0199dd00-0000-7000-8000-0000000000a1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: CALLER_MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
    ...over,
  } as Principal;
}

const context = {
  organizationId: ORG,
  membershipId: CALLER_MEMBERSHIP,
  userId: '0199dd00-0000-7000-8000-0000000000a1',
} as unknown as TenantContext;

class FakeRepo {
  writes = 0;
  readonly members = new Map<string, OverrideMember>([
    [
      CALLER_MEMBERSHIP,
      {
        id: CALLER_MEMBERSHIP,
        userId: context.userId,
        role: 'org_admin',
        status: 'active',
        hasOrgWideScope: true,
        workspaceScopeId: null,
      },
    ],
    [
      TARGET,
      {
        id: TARGET,
        userId: '0199dd00-0000-7000-8000-0000000000a2',
        role: 'member',
        status: 'active',
        hasOrgWideScope: false,
        workspaceScopeId: null,
      },
    ],
    [
      OWNER_SEAT,
      {
        id: OWNER_SEAT,
        userId: '0199dd00-0000-7000-8000-0000000000a3',
        role: 'owner',
        status: 'active',
        hasOrgWideScope: true,
        workspaceScopeId: null,
      },
    ],
  ]);
  rows: MembershipOverrideRecord[] = [];

  findMember(_r: unknown, _c: unknown, id: string): Promise<OverrideMember | undefined> {
    return Promise.resolve(this.members.get(id));
  }

  list(): Promise<readonly MembershipOverrideRecord[]> {
    return Promise.resolve(this.rows);
  }

  liveOverrides(): Promise<PermissionOverrides> {
    const live = this.rows.filter((row) => row.live);
    return Promise.resolve({
      allow: live.filter((r) => r.effect === 'allow').map((r) => r.capability),
      deny: live.filter((r) => r.effect === 'deny').map((r) => r.capability),
    });
  }

  projectIdsOf(): Promise<readonly string[]> {
    return Promise.resolve([PROJECT]);
  }

  replace(_tx: unknown, _c: unknown, _id: string, next: readonly ValidOverride[]) {
    this.writes += 1;
    const revoked = this.rows;
    this.rows = next.map((entry, index) => ({
      id: `row-${index}`,
      capability: entry.capability,
      effect: entry.effect,
      reason: entry.reason,
      expiresAt: entry.expiresAt,
      createdBy: context.userId,
      createdAt: new Date('2026-10-28T10:00:00.000Z'),
      live: true,
    }));
    return Promise.resolve({ added: next, revoked });
  }
}

function setup() {
  const repo = new FakeRepo();
  const recorded: unknown[] = [];
  const database = {
    read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const audit = {
    record: (_tx: unknown, _c: unknown, input: unknown) => {
      recorded.push(input);
      return Promise.resolve({});
    },
  } as unknown as AuditService;
  const customRoles = {
    findRoleById: () => Promise.resolve(undefined),
  } as unknown as MemberBulkRoleRepository;
  const controller = new MembershipOverridesController(
    database,
    repo as unknown as MembershipOverridesRepository,
    audit,
    customRoles,
  );
  return { repo, recorded, controller };
}

async function statusOf(promise: Promise<unknown>): Promise<number | undefined> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  return error instanceof ApiError ? error.status : undefined;
}

const body = (overrides: { capability: Capability; effect: 'allow' | 'deny' }[]) => ({ overrides });

describe('route capabilities', () => {
  const proto = MembershipOverridesController.prototype;
  it.each([
    ['list', 'roles.assign'],
    ['replace', 'roles.assign'],
    ['effective', 'people.view'],
    ['me', 'approval.read'],
  ] as const)('%s requires %s', (method, capability) => {
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, proto[method])).toBe(capability);
  });
});

describe('PUT …/permissions/overrides', () => {
  it('replaces the overrides, audits each change and returns the new list', async () => {
    const { controller, repo, recorded } = setup();
    const view = await controller.replace(
      context,
      principal('org_admin'),
      TARGET,
      body([{ capability: 'report.export', effect: 'allow' }]),
    );
    expect(repo.writes).toBe(1);
    expect(view).toMatchObject({ membershipId: TARGET, added: 1, removed: 0 });
    expect(view.overrides[0]).toMatchObject({ capability: 'report.export', effect: 'allow' });
    expect(recorded).toEqual([
      expect.objectContaining({
        action: 'membership.permission_overrides_changed',
        objectId: TARGET,
        changes: [{ field: 'override.report.export', before: null, after: 'allow' }],
      }),
    ]);
  });

  it('is a 404 for a membership of another organization, before any decision', async () => {
    const { controller, repo } = setup();
    expect(
      await statusOf(
        controller.replace(
          context,
          principal('member', { hasOrgWideScope: false }),
          FOREIGN,
          body([]),
        ),
      ),
    ).toBe(404);
    expect(repo.writes).toBe(0);
  });

  it('is a 403 without roles.assign', async () => {
    const { controller, repo } = setup();
    expect(
      await statusOf(controller.replace(context, principal('manager'), TARGET, body([]))),
    ).toBe(403);
    expect(repo.writes).toBe(0);
  });

  it('refuses an owner (400) and one’s own overrides (403)', async () => {
    const { controller, repo } = setup();
    expect(
      await statusOf(
        controller.replace(
          context,
          principal('owner'),
          OWNER_SEAT,
          body([{ capability: 'work.read', effect: 'deny' }]),
        ),
      ),
    ).toBe(400);
    expect(
      await statusOf(
        controller.replace(context, principal('org_admin'), CALLER_MEMBERSHIP, body([])),
      ),
    ).toBe(403);
    expect(repo.writes).toBe(0);
  });

  it('refuses an allow the caller does not hold (403, no write)', async () => {
    const { controller, repo } = setup();
    const delegate = principal(
      customRoleKey('0199dd00-0000-7000-8000-0000000000f1', ['roles.assign', 'people.view']),
    );
    expect(
      await statusOf(
        controller.replace(
          context,
          delegate,
          TARGET,
          body([{ capability: 'billing.manage', effect: 'allow' }]),
        ),
      ),
    ).toBe(403);
    expect(repo.writes).toBe(0);
  });
});

describe('GET …/permissions/overrides', () => {
  it('lists the overrides and says an owner is not editable', async () => {
    const { controller } = setup();
    expect(await controller.list(context, principal('org_admin'), TARGET)).toMatchObject({
      membershipId: TARGET,
      role: 'member',
      editable: true,
      overrides: [],
    });
    expect((await controller.list(context, principal('org_admin'), OWNER_SEAT)).editable).toBe(
      false,
    );
  });
});

describe('GET …/effective-permissions', () => {
  it('previews another member for a role assigner, overrides included', async () => {
    const { controller, repo } = setup();
    await repo.replace({}, context, TARGET, [
      { capability: 'report.export', effect: 'allow', reason: null, expiresAt: null },
    ]);
    const view = await controller.effective(context, principal('org_admin'), TARGET, PROJECT);
    expect(view.projectId).toBe(PROJECT);
    const byCapability = new Map(view.permissions.map((entry) => [entry.capability, entry]));
    expect(byCapability.get('work.read')).toMatchObject({ final: true, source: 'role' });
    expect(byCapability.get('report.export')).toMatchObject({
      final: true,
      source: 'override_allow',
    });
    expect(byCapability.get('org.manage')).toMatchObject({ final: false });
  });

  it('lets a member read only their own preview', async () => {
    const { controller } = setup();
    const member = principal('member', { hasOrgWideScope: false });
    expect(await statusOf(controller.effective(context, member, TARGET))).toBe(403);
    const self = principal('member', { hasOrgWideScope: false, membershipId: TARGET });
    expect((await controller.effective(context, self, TARGET)).membershipId).toBe(TARGET);
  });

  it('refuses a malformed project id', async () => {
    const { controller } = setup();
    expect(
      await statusOf(controller.effective(context, principal('org_admin'), TARGET, 'nope')),
    ).toBe(400);
  });
});

describe('GET …/me', () => {
  it('returns the role, the effective set, the overrides and no support session', () => {
    const { controller } = setup();
    const request = {};
    const view = controller.me(
      principal('member', { overrides: { allow: ['report.export'], deny: ['work.read'] } }),
      request,
    );
    expect(view.role).toBe('member');
    expect(view.capabilities).toContain('report.export');
    expect(view.capabilities).not.toContain('work.read');
    expect(view.overrides).toEqual({ allow: ['report.export'], deny: ['work.read'] });
    expect(view.supportSession).toBeNull();
  });

  it('names the support session for TManage support and a custom role by its id', () => {
    const { controller } = setup();
    const request = {};
    ensureRequestState(request).membership = {
      supportSession: {
        id: '0199dd00-0000-7000-8000-0000000000e1',
        adminUserId: '0199dd00-0000-7000-8000-0000000000e2',
        expiresAt: new Date('2026-10-28T12:00:00.000Z'),
      },
    } as unknown as ResolvedMembership;
    const support = controller.me(principal('platform_support'), request);
    expect(support.supportSession).toEqual({
      id: '0199dd00-0000-7000-8000-0000000000e1',
      expiresAt: '2026-10-28T12:00:00.000Z',
    });
    const roleId = '0199dd00-0000-7000-8000-0000000000f1';
    expect(controller.me(principal(customRoleKey(roleId, ['work.read'])), {}).role).toBe(roleId);
  });
});
