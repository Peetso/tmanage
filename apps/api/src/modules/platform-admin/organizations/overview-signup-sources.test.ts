import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import type { PlatformPermission } from '@tmanage/domain';
import { ensureRequestState } from '../../../common/http/request-state.js';
import { PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminLookup } from '../platform-admin.guard.js';
import { PlatformOrganizationsController } from './organizations.controller.js';

const USER = '0199aa00-0000-7000-8000-0000000000d1';

/** The real guard over the real `GET /v1/platform/overview` metadata. */
async function overviewStatus(permissions: PlatformPermission[] | null): Promise<number> {
  const lookup: PlatformAdminLookup = {
    findAccount: async () => ({
      userId: USER,
      email: 'owner@example.com',
      displayName: 'O',
      emailVerified: true,
      mfaEnabled: true,
    }),
    findLiveStepUp: async () => ({ expiresAt: new Date(Date.now() + 600_000), mfaVerified: true }),
    findPlatformAdmin: async () =>
      permissions === null
        ? null
        : {
            id: 'admin-1',
            userId: USER,
            preset: 'support',
            customPermissions: null,
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
    getHandler: () => PlatformOrganizationsController.prototype.overview,
    getClass: () => PlatformOrganizationsController,
  } as unknown as ExecutionContext;
  return guard.canActivate(context).then(
    () => 200,
    (error: { status: number }) => error.status,
  );
}

/** ADTRACK: "Where sign-ups came from" rides the operator overview; nobody else reads it. */
describe('GET /v1/platform/overview (sign-up sources)', () => {
  it('runs behind the platform admin guard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PlatformOrganizationsController)).toContain(
      PlatformAdminGuard,
    );
  });

  it('refuses a workspace owner who is not on the platform team, and a member without platform.orgs.view', async () => {
    expect([
      await overviewStatus(null),
      await overviewStatus(['platform.activity.view']),
      await overviewStatus(['platform.orgs.view']),
    ]).toEqual([404, 403, 200]);
  });
});
