import { describe, expect, it, vi } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../../common/database/tenant-context.js';
import { ApiError } from '../../../common/http/errors.js';
import { auditOriginOf } from '../../../common/http/request-origin.js';
import { MembershipNotResolvedError } from '../../tenancy/membership-resolver.repository.js';
import type { ResolvedMembership } from '../../tenancy/membership-resolver.repository.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { SupportContextResolver } from './support-context.js';

const ORG = '0199aa00-0000-7000-8000-00000000a001';
const ADMIN = 'admin-user';
const SESSION = '0199aa00-0000-7000-8000-00000000c001';

const actor: PlatformAdminActor = {
  account: {
    userId: ADMIN,
    email: 'peter@peetrix.com',
    displayName: 'Peter',
    emailVerified: true,
    mfaEnabled: true,
  },
  sessionId: 'browser-1',
  stepUp: { expiresAt: new Date(Date.now() + 600_000), mfaVerified: true },
  permissions: ['platform.content.view', 'platform.content.moderate'],
};

const context: TenantContext = {
  organizationId: ORG,
  userId: ADMIN,
  principalKind: 'internal',
  membershipId: 'hidden-membership',
  capabilities: [],
  policyVersion: 'v2:1:1',
  correlationId: 'corr-1',
} as TenantContext;

function resolved(supportSession: ResolvedMembership['supportSession']): ResolvedMembership {
  return {
    context,
    role: 'platform_support',
    clientOrganizationId: null,
    hasOrgWideScope: true,
    workspaceScopeId: null,
    supportSession,
  } as ResolvedMembership;
}

function setup(resolve: () => Promise<ResolvedMembership>) {
  const database = {
    read: vi.fn(async (_ctx: TenantContext, work: (runner: unknown) => Promise<unknown>) =>
      work({}),
    ),
  };
  const principals = { load: vi.fn(async () => ({ userId: ADMIN, kind: 'internal' })) };
  const resolver = { resolve: vi.fn(resolve) };
  const support = new SupportContextResolver(
    database as unknown as TenantDatabase,
    resolver,
    principals as never,
  );
  return { support, database, principals, resolver };
}

const REQUEST = {
  correlationId: 'corr-1',
  request: { ip: '203.0.113.9', headers: { 'user-agent': 'vitest' } },
};

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('SupportContextResolver (PA-08, SPEC §5.4)', () => {
  it('answers 428 support_session_required when no live session resolves the hidden row', async () => {
    const { support, principals } = setup(async () => {
      throw new MembershipNotResolvedError('no_active_membership');
    });
    const error = await refusal(support.resolve(actor, ORG, REQUEST));
    expect(error.status).toBe(428);
    expect(error.code).toBe('support_session_required');
    expect(principals.load).not.toHaveBeenCalled();
  });

  it("refuses an admin's ordinary membership: it is not a support visit", async () => {
    const { support } = setup(async () => resolved(null));
    const error = await refusal(support.resolve(actor, ORG, REQUEST));
    expect(error.status).toBe(428);
    expect(error.auditCode).toBe('membership_is_not_a_support_visit');
  });

  it('refuses a session that belongs to another admin', async () => {
    const { support } = setup(async () =>
      resolved({ id: SESSION, adminUserId: 'someone-else', expiresAt: new Date() }),
    );
    expect((await refusal(support.resolve(actor, ORG, REQUEST))).status).toBe(428);
  });

  it('answers 404 for an id that is not an id, before any read', async () => {
    const { support, resolver } = setup(async () => resolved(null));
    expect((await refusal(support.resolve(actor, 'not-an-id', REQUEST))).status).toBe(404);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('builds the tenant context of the hidden membership, stamped with the session', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    const { support, resolver, principals } = setup(async () =>
      resolved({ id: SESSION, adminUserId: ADMIN, expiresAt }),
    );
    const scope = await support.resolve(actor, ORG, REQUEST);
    expect(resolver.resolve).toHaveBeenCalledWith({
      userId: ADMIN,
      organization: { organizationId: ORG },
      correlationId: 'corr-1',
    });
    expect(scope.organizationId).toBe(ORG);
    expect(scope.context.organizationId).toBe(ORG);
    expect(scope.context.membershipId).toBe('hidden-membership');
    expect(scope.session).toEqual({ id: SESSION, adminUserId: ADMIN, expiresAt });
    const origin = auditOriginOf(scope.context);
    expect(origin?.supportSession?.id).toBe(SESSION);
    expect(origin?.ip).toBe('203.0.113.9');
    expect(principals.load).toHaveBeenCalledTimes(1);
  });
});
