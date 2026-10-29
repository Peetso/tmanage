import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { ACCOUNT_DISABLED_REASON, SessionAuthGuard } from './session-auth.guard.js';
import { requireRequestState } from '../request-state.js';
import { SKIPS_TENANT } from '../decorators.js';
import { SessionNotAuthenticatedError } from '../../../modules/identity/session.service.js';
import { MESSAGES } from '../errors.js';

/**
 * Platform admin v2 · PA-06 (0247) — the account's standing at the session check.
 *
 * - A disabled account's session is refused with the SAME neutral 401 as any dead session; only
 *   the `authentication_events` row (reason `account_disabled`) and the audit code say why.
 * - An account whose two-step an operator requires reaches no organization route (403
 *   `two_step_required`) until a confirmed factor exists; `@NoTenant()` routes stay open.
 */

const USER = '0198f4a2-1c00-7000-8000-00000000000c';

function guardWith(options: {
  authenticate: () => Promise<unknown>;
  skipsTenant?: boolean;
  enrolled?: boolean;
  recordGuardRefusal?: ReturnType<typeof vi.fn>;
}) {
  const recordGuardRefusal = options.recordGuardRefusal ?? vi.fn();
  const identityRead = vi.fn(async () => options.enrolled ?? false);
  const guard = new SessionAuthGuard(
    {
      getAllAndOverride: (key: unknown) => (key === SKIPS_TENANT ? options.skipsTenant : false),
    } as never,
    { authenticate: vi.fn(options.authenticate) } as never,
    { cookieName: 'tm' } as never,
    { recordGuardRefusal } as never,
    { authenticate: vi.fn() } as never,
    undefined,
    { identityRead } as never,
  );
  return { guard, recordGuardRefusal, identityRead };
}

function contextFor(request: unknown): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function cookieRequest(url = '/v1/organizations/acme/projects') {
  return { ip: '41.33.10.8', url, headers: { cookie: 'tm=signed-access-token' } };
}

describe('SessionAuthGuard — account standing (PA-06)', () => {
  it('refuses a disabled account with the neutral 401 and records account_disabled', async () => {
    const { guard, recordGuardRefusal } = guardWith({
      authenticate: () => Promise.reject(new SessionNotAuthenticatedError('account_disabled')),
    });
    await expect(guard.canActivate(contextFor(cookieRequest()))).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
      message: MESSAGES.unauthenticated,
      auditCode: 'account_disabled',
    });
    expect(recordGuardRefusal).toHaveBeenCalledWith(
      expect.objectContaining({ reason: ACCOUNT_DISABLED_REASON, ip: '41.33.10.8' }),
    );
  });

  it('a revoked session still records the ordinary missing_session reason', async () => {
    const { guard, recordGuardRefusal } = guardWith({
      authenticate: () => Promise.reject(new SessionNotAuthenticatedError('session_revoked')),
    });
    await expect(guard.canActivate(contextFor(cookieRequest()))).rejects.toMatchObject({
      status: 401,
    });
    expect(recordGuardRefusal).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'missing_session' }),
    );
  });

  it('passes the request address to the session check (ip_first / ip_last stamping)', async () => {
    const authenticate = vi.fn(async () => ({
      sessionId: 's1',
      userId: USER,
      twoStepRequired: false,
    }));
    const { guard } = guardWith({ authenticate });
    const request = cookieRequest();
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(authenticate).toHaveBeenCalledWith(expect.objectContaining({ ip: '41.33.10.8' }));
    expect(requireRequestState(request).session).toEqual({ sessionId: 's1', userId: USER });
  });

  it('two-step required and not enrolled: an organization route answers 403 two_step_required', async () => {
    const { guard } = guardWith({
      authenticate: async () => ({ sessionId: 's1', userId: USER, twoStepRequired: true }),
      enrolled: false,
    });
    await expect(guard.canActivate(contextFor(cookieRequest()))).rejects.toMatchObject({
      status: 403,
      code: 'two_step_required',
    });
  });

  it('two-step required: @NoTenant routes (enrolment) and the own profile stay open', async () => {
    const noTenant = guardWith({
      authenticate: async () => ({ sessionId: 's1', userId: USER, twoStepRequired: true }),
      skipsTenant: true,
    });
    await expect(
      noTenant.guard.canActivate(contextFor(cookieRequest('/v1/auth/factors/totp'))),
    ).resolves.toBe(true);
    expect(noTenant.identityRead).not.toHaveBeenCalled();

    const profile = guardWith({
      authenticate: async () => ({ sessionId: 's1', userId: USER, twoStepRequired: true }),
    });
    await expect(
      profile.guard.canActivate(contextFor(cookieRequest('/v1/organizations/acme/me/profile'))),
    ).resolves.toBe(true);
  });

  it('two-step required and enrolled: passes', async () => {
    const { guard } = guardWith({
      authenticate: async () => ({ sessionId: 's1', userId: USER, twoStepRequired: true }),
      enrolled: true,
    });
    await expect(guard.canActivate(contextFor(cookieRequest()))).resolves.toBe(true);
  });
});
