import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { supportSessionOf, TenantContextGuard } from './tenant-context.guard.js';
import { auditOriginOf } from '../request-origin.js';
import { ApiError } from '../errors.js';
import { requireRequestState } from '../request-state.js';

/**
 * Security test for the personal-access-token org binding (0202, manager-directed).
 *
 * The resolver proves the member belongs to the requested org; the guard then enforces that a
 * Bearer token acts ONLY in the org it was created in. A token presented against another org the
 * member also belongs to is refused with the same 404 as any other cross-tenant attempt, and the
 * principal is never loaded for it. A cookie session carries no binding and is unaffected.
 */

const USER = '0198f4a2-1c00-7000-8000-00000000000c';
const reflector = { getAllAndOverride: () => false } as never;

function contextFor(request: unknown): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guardResolvingTo(
  organizationId: string,
  loadPrincipal = vi.fn(async () => ({})),
  supportSession: unknown = undefined,
) {
  const resolver = {
    resolve: vi.fn(async () => ({
      context: { organizationId, userId: USER },
      role: 'owner',
      clientOrganizationId: null,
      hasOrgWideScope: true,
      workspaceScopeId: null,
      ...(supportSession === undefined ? {} : { supportSession }),
    })),
  } as never;
  const principals = { load: loadPrincipal } as never;
  const database = {
    read: vi.fn(async (ctx: unknown, work: (runner: unknown) => Promise<unknown>) => work({ ctx })),
  } as never;
  return {
    guard: new TenantContextGuard(reflector, resolver, principals, database),
    loadPrincipal,
  };
}

describe('TenantContextGuard — personal access token org binding', () => {
  it('lets a token act in the organization it is bound to', async () => {
    const { guard } = guardResolvingTo('org-a');
    const request = { params: { orgSlug: 'org-a' } };
    const state = requireRequestState(request);
    state.session = { sessionId: 'pat:t1', userId: USER };
    state.authScheme = 'personal_access_token';
    state.personalAccessToken = { organizationId: 'org-a', membershipId: 'm1' };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(state.tenant?.organizationId).toBe('org-a');
  });

  it('refuses a token against another org the member belongs to, without loading a principal', async () => {
    const { guard, loadPrincipal } = guardResolvingTo('org-b');
    const request = { params: { orgSlug: 'org-b' } };
    const state = requireRequestState(request);
    state.session = { sessionId: 'pat:t1', userId: USER };
    state.authScheme = 'personal_access_token';
    state.personalAccessToken = { organizationId: 'org-a', membershipId: 'm1' };

    await expect(guard.canActivate(contextFor(request))).rejects.toMatchObject({
      status: 404,
      auditCode: 'token_organization_mismatch',
    });
    await expect(guard.canActivate(contextFor(request))).rejects.toBeInstanceOf(ApiError);
    expect(loadPrincipal).not.toHaveBeenCalled();
    expect(state.tenant).toBeUndefined();
  });

  it('does not constrain a cookie session', async () => {
    const { guard } = guardResolvingTo('org-b');
    const request = { params: { orgSlug: 'org-b' } };
    const state = requireRequestState(request);
    state.session = { sessionId: 's1', userId: USER };
    state.authScheme = 'cookie';

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(state.tenant?.organizationId).toBe('org-b');
  });
});

// ---- platform-admin v2 · PA-02 ----
describe('TenantContextGuard — support session and request origin (PA-02)', () => {
  const SUPPORT = { id: 'pss-1', adminUserId: 'admin-1', expiresAt: new Date('2999-01-01') };

  it('puts the resolver’s support session on the request state and the context origin', async () => {
    const { guard } = guardResolvingTo('org-s', undefined, SUPPORT);
    const request = {
      params: { orgSlug: 'org-s' },
      ip: '203.0.113.9',
      headers: { 'user-agent': 'Browser/1.0' },
    };
    const state = requireRequestState(request);
    state.session = { sessionId: 's1', userId: USER };
    state.authScheme = 'cookie';

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(supportSessionOf(request)).toEqual(SUPPORT);
    expect(auditOriginOf(state.tenant!)).toEqual({
      ip: '203.0.113.9',
      userAgent: 'Browser/1.0',
      supportSession: SUPPORT,
    });
  });

  it('is null for an ordinary member, and the origin still carries ip and device', async () => {
    const { guard } = guardResolvingTo('org-m', undefined, null);
    const request = { params: { orgSlug: 'org-m' }, ip: '198.51.100.1', headers: {} };
    const state = requireRequestState(request);
    state.session = { sessionId: 's1', userId: USER };
    state.authScheme = 'cookie';

    await guard.canActivate(contextFor(request));
    expect(supportSessionOf(request)).toBeNull();
    expect(auditOriginOf(state.tenant!)).toEqual({
      ip: '198.51.100.1',
      userAgent: null,
      supportSession: null,
    });
  });

  it('works before the resolver carries the field at all', async () => {
    const { guard } = guardResolvingTo('org-x');
    const request = { params: { orgSlug: 'org-x' }, headers: {} };
    const state = requireRequestState(request);
    state.session = { sessionId: 's1', userId: USER };
    state.authScheme = 'cookie';

    await guard.canActivate(contextFor(request));
    expect(supportSessionOf(request)).toBeNull();
  });
});

// ---- platform-admin v2 · verifier ----
describe('TenantContextGuard — a token never acts through a Support visit', () => {
  it('refuses a bound token whose membership is a live platform_support row', async () => {
    const support = { id: 'pss-2', adminUserId: USER, expiresAt: new Date('2999-01-01') };
    const { guard, loadPrincipal } = guardResolvingTo('org-s', undefined, support);
    const request = { params: { orgSlug: 'org-s' } };
    const state = requireRequestState(request);
    state.session = { sessionId: 'pat:t9', userId: USER };
    state.authScheme = 'personal_access_token';
    state.personalAccessToken = { organizationId: 'org-s', membershipId: 'm-support' };

    await expect(guard.canActivate(contextFor(request))).rejects.toMatchObject({
      status: 404,
      auditCode: 'support_membership_token_refused',
    });
    expect(loadPrincipal).not.toHaveBeenCalled();
    expect(state.tenant).toBeUndefined();
  });
});
