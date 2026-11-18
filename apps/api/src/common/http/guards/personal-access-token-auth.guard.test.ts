import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { SessionAuthGuard } from './session-auth.guard.js';
import { CsrfGuard } from './csrf.guard.js';
import { ApiError } from '../errors.js';
import { requireRequestState } from '../request-state.js';
import { mintCsrfToken } from '../csrf.js';
import { mintPersonalAccessToken } from '../../../modules/personal-access-tokens/personal-access-token.js';
import { PersonalAccessTokenNotAuthenticatedError } from '../../../modules/personal-access-tokens/personal-access-tokens.service.js';

/**
 * Security tests for the Bearer personal-access-token path and the CSRF interaction
 * (manager-directed). The guards are built with hand-rolled fakes so no Nest container or
 * server is needed.
 */

const USER = '0198f4a2-1c00-7000-8000-00000000000c';
const CSRF_SECRET = 'csrf-secret-for-tests-only';

type Request = { method: string; ip?: string; headers: Record<string, string | undefined> };

function contextFor(request: Request): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const reflector = { getAllAndOverride: () => false } as never;
const events = { recordGuardRefusal: vi.fn() } as never;
const config = { cookieName: 'tm', sessionSecret: 's', csrfSecret: CSRF_SECRET } as never;

describe('SessionAuthGuard — Bearer personal access token', () => {
  const token = mintPersonalAccessToken().token;

  it('authenticates a Bearer token when there is no session cookie, marking the scheme', async () => {
    const sessions = { authenticate: vi.fn() } as never;
    const pat = {
      authenticate: vi.fn(async () => ({
        tokenId: 't1',
        name: 'Claude on my laptop',
        organizationId: 'o',
        membershipId: 'm',
        userId: USER,
      })),
    } as never;
    const guard = new SessionAuthGuard(reflector, sessions, config, events, pat);
    const request: Request = { method: 'POST', headers: { authorization: `Bearer ${token}` } };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    const state = requireRequestState(request);
    expect(state.session?.userId).toBe(USER);
    expect(state.authScheme).toBe('personal_access_token');
    // The token's org/membership binding is carried forward so TenantContextGuard can refuse the
    // token against any other org (0202). It is the token row's own org, not the requested one.
    expect(state.personalAccessToken).toEqual({
      organizationId: 'o',
      membershipId: 'm',
      name: 'Claude on my laptop',
    });
    expect(
      (sessions as { authenticate: ReturnType<typeof vi.fn> }).authenticate,
    ).not.toHaveBeenCalled();
  });

  it('prefers the session cookie when both a cookie and a Bearer header are present', async () => {
    const sessions = {
      authenticate: vi.fn(async () => ({ sessionId: 's1', userId: USER })),
    } as never;
    const pat = { authenticate: vi.fn() } as never;
    const guard = new SessionAuthGuard(reflector, sessions, config, events, pat);
    const request: Request = {
      method: 'POST',
      headers: { cookie: 'tm=cookie-access-token', authorization: `Bearer ${token}` },
    };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    const state = requireRequestState(request);
    expect(state.authScheme).toBe('cookie');
    expect((pat as { authenticate: ReturnType<typeof vi.fn> }).authenticate).not.toHaveBeenCalled();
  });

  it('refuses a bad Bearer token with a 401', async () => {
    const sessions = { authenticate: vi.fn() } as never;
    const pat = {
      authenticate: vi.fn(async () => {
        throw new PersonalAccessTokenNotAuthenticatedError('revoked');
      }),
    } as never;
    const guard = new SessionAuthGuard(reflector, sessions, config, events, pat);
    const request: Request = { method: 'POST', headers: { authorization: `Bearer ${token}` } };

    await expect(guard.canActivate(contextFor(request))).rejects.toMatchObject({ status: 401 });
  });
});

describe('CsrfGuard — personal access tokens are exempt, cookies are not', () => {
  it('skips CSRF for a PAT-authenticated request', () => {
    const guard = new CsrfGuard(reflector, config, events);
    const request: Request = { method: 'POST', headers: { authorization: 'Bearer x' } };
    const state = requireRequestState(request);
    state.session = { sessionId: 'pat:t1', userId: USER };
    state.authScheme = 'personal_access_token';
    expect(guard.canActivate(contextFor(request))).toBe(true);
  });

  it('still enforces CSRF for a cookie session even if a Bearer header is present', () => {
    const guard = new CsrfGuard(reflector, config, events);
    const request: Request = {
      method: 'POST',
      headers: { cookie: 'tm=x', authorization: 'Bearer x' },
    };
    const state = requireRequestState(request);
    state.session = { sessionId: 's1', userId: USER };
    state.authScheme = 'cookie';
    // No X-CSRF-Token header → refused.
    expect(() => guard.canActivate(contextFor(request))).toThrow(ApiError);
    // With the matching token it passes, proving the check really ran.
    request.headers['x-csrf-token'] = mintCsrfToken('s1', CSRF_SECRET);
    expect(guard.canActivate(contextFor(request))).toBe(true);
  });
});
