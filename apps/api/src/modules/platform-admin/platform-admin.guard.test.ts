import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ensureRequestState } from '../../common/http/request-state.js';
import { parsePlatformAdminEmails } from './platform-admin.access.js';
import { PlatformAdminController } from './platform-admin.controller.js';
import { PlatformAdminGuard } from './platform-admin.guard.js';
import type { PlatformAdminAccount } from './platform-admin.repository.js';

/** Who reaches `/v1/platform/*` — the real guard, Reflector and route metadata over a fake lookup. */

const USER = '0199aa00-0000-7000-8000-0000000000a1';

async function attempt(o: {
  allowlist: string;
  account?: Partial<PlatformAdminAccount>;
  stepUp?: boolean;
  scheme?: 'cookie' | 'personal_access_token';
  route?: 'me' | 'suspend';
}): Promise<{ status: number; code: string | undefined } | 'admitted'> {
  const account = {
    userId: USER,
    email: 'Peter@Example.com',
    displayName: 'P',
    emailVerified: true,
    mfaEnabled: true,
    ...o.account,
  };
  const guard = new PlatformAdminGuard(new Reflector(), parsePlatformAdminEmails(o.allowlist), {
    findAccount: async () => account,
    findLiveStepUp: async () => (o.stepUp ? { expiresAt: new Date(), mfaVerified: true } : null),
  });
  const request = { headers: {} };
  const state = ensureRequestState(request);
  state.session = { sessionId: 's', userId: USER };
  state.authScheme = o.scheme ?? 'cookie';
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => PlatformAdminController.prototype[o.route ?? 'suspend'],
    getClass: () => PlatformAdminController,
  } as unknown as ExecutionContext;
  return guard.canActivate(context).then(
    () => 'admitted' as const,
    (error: { status: number; code?: string }) => ({ status: error.status, code: error.code }),
  );
}

describe('PlatformAdminGuard', () => {
  it('is a 404 for everyone while PLATFORM_ADMIN_EMAILS is unset', async () => {
    expect(await attempt({ allowlist: '', stepUp: true })).toEqual({
      status: 404,
      code: 'not_found',
    });
  });

  it('refuses an email not on the list — an organization owner included — with the same 404', async () => {
    const owner = await attempt({
      allowlist: 'peter@example.com',
      account: { email: 'owner@customer.test' },
      stepUp: true,
    });
    expect(owner).toEqual({ status: 404, code: 'not_found' });
    expect(
      await attempt({
        allowlist: 'peter@example.com',
        account: { emailVerified: false },
        stepUp: true,
      }),
    ).toMatchObject({ status: 404 });
    expect(
      await attempt({
        allowlist: 'peter@example.com',
        scheme: 'personal_access_token',
        stepUp: true,
      }),
    ).toMatchObject({ status: 404 });
  });

  it('requires a fresh password (+ two-step code) confirmation for every action', async () => {
    expect(await attempt({ allowlist: 'PETER@example.com', stepUp: false })).toEqual({
      status: 403,
      code: 'reauthentication_required',
    });
    expect(
      await attempt({
        allowlist: 'peter@example.com',
        account: { mfaEnabled: false },
        stepUp: false,
      }),
    ).toMatchObject({ status: 403 });
    expect(await attempt({ allowlist: 'peter@example.com', stepUp: true })).toBe('admitted');
  });

  it('lets a listed operator read their own status before confirming', async () => {
    expect(await attempt({ allowlist: 'peter@example.com', stepUp: false, route: 'me' })).toBe(
      'admitted',
    );
  });
});
