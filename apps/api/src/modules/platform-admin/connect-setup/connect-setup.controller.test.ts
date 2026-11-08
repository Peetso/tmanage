import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PlatformPermission } from '@tmanage/domain';
import { ensureRequestState } from '../../../common/http/request-state.js';
import { PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminLookup } from '../platform-admin.guard.js';
import { PlatformConnectSetupController } from './connect-setup.controller.js';
import { connectSetupView, providerErrorReason } from './connect-setup.js';

const USER = '0199aa00-0000-7000-8000-0000000000c7';

/** The real guard over the real route metadata; `permissions` on the team row, no step-up. */
async function guardStatus(permissions: PlatformPermission[] | null): Promise<number> {
  const lookup: PlatformAdminLookup = {
    findAccount: async () => ({
      userId: USER,
      email: 'owner@example.com',
      displayName: 'O',
      emailVerified: true,
      mfaEnabled: true,
    }),
    // No live step-up: the route is exempt, so an owner reaches it from Connected apps.
    findLiveStepUp: async () => null,
    findPlatformAdmin: async () =>
      permissions === null
        ? null
        : {
            id: 'admin-1',
            userId: USER,
            preset: 'custom',
            customPermissions: permissions,
            permissions,
            status: 'active',
          },
    hasActivePlatformAdmins: async () => true,
  };
  const guard = new PlatformAdminGuard(new Reflector(), [], lookup);
  const request = { headers: {} };
  const state = ensureRequestState(request);
  state.session = { sessionId: 's', userId: USER };
  state.authScheme = 'cookie';
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => PlatformConnectSetupController.prototype.read,
    getClass: () => PlatformConnectSetupController,
  } as unknown as ExecutionContext;
  return guard.canActivate(context).then(
    () => 200,
    (error: { status: number }) => error.status,
  );
}

describe('R37 GET /v1/platform/connect-setup — platform owner only', () => {
  it('lets a platform admin holding platform.settings.edit in, without a step-up', async () => {
    expect(await guardStatus(['platform.settings.edit'])).toBe(200);
  });

  it('refuses a platform admin without platform.settings.edit (403)', async () => {
    expect(await guardStatus(['platform.orgs.view'])).toBe(403);
  });

  it('hides itself from a workspace user who is not a platform admin (404)', async () => {
    expect(await guardStatus(null)).toBe(404);
  });
});

describe('R37 connectSetupView — booleans and public addresses only', () => {
  it('reports which providers are set and the exact return addresses, never a secret', () => {
    const env = {
      API_PUBLIC_URL: 'https://tmanage.example.com/',
      GOOGLE_CLIENT_ID: 'id-123.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'super-secret-value',
    };
    const view = connectSetupView(env);
    const google = view.providers.find((p) => p.provider === 'google');
    const microsoft = view.providers.find((p) => p.provider === 'microsoft');
    expect(view.publicAddressSet).toBe(true);
    expect(google?.configured).toBe(true);
    expect(microsoft?.configured).toBe(false);
    expect(google?.redirectUrls).toEqual([
      'https://tmanage.example.com/v1/auth/google/callback',
      'https://tmanage.example.com/v1/integrations/google-calendar/callback',
      'https://tmanage.example.com/v1/integrations/google-drive/callback',
    ]);
    expect(microsoft?.redirectUrls).toEqual([
      'https://tmanage.example.com/v1/integrations/onedrive/callback',
      'https://tmanage.example.com/v1/integrations/microsoft-calendar/callback',
    ]);
    const text = JSON.stringify(view);
    expect(text).not.toContain('super-secret-value');
    expect(text).not.toContain('id-123');
  });

  it('keeps only the provider error codes it explains', () => {
    expect(providerErrorReason('redirect_uri_mismatch')).toBe('redirect_uri_mismatch');
    expect(providerErrorReason('<script>')).toBeNull();
    expect(providerErrorReason(undefined)).toBeNull();
  });
});
