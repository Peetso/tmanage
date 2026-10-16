import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { TenantContextGuard } from './tenant-context.guard.js';
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

function guardResolvingTo(organizationId: string, loadPrincipal = vi.fn(async () => ({}))) {
  const resolver = {
    resolve: vi.fn(async () => ({
      context: { organizationId, userId: USER },
      role: 'owner',
      clientOrganizationId: null,
      hasOrgWideScope: true,
      workspaceScopeId: null,
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
