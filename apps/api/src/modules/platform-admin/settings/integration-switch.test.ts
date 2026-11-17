import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import type { PlatformPermission } from '@tmanage/domain';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { ensureRequestState } from '../../../common/http/request-state.js';
import { AppConnectController } from '../../app-connect/app-connect.controller.js';
import { FigmaController } from '../../figma/figma.controller.js';
import { GoogleDriveStorageController } from '../../google-drive/google-drive.controller.js';
import { PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminLookup } from '../platform-admin.guard.js';
import {
  createIntegrationSwitchesFrom,
  forgetIntegrationSwitches,
  IntegrationSwitchGuard,
  requireIntegrationOn,
} from './integration-switch.js';
import { PlatformSettingsController } from './settings.controller.js';

/** 51-15p — the platform kill switch of a connected service, enforced on the server. */

const USER = '0199aa00-0000-7000-8000-0000000000d1';

function storedSwitches(initial: Record<string, string>) {
  const stored = { ...initial };
  const switches = createIntegrationSwitchesFrom(async (key) => stored[key] ?? null);
  return { switches, stored };
}

describe('requireIntegrationOn', () => {
  it('refuses with the 409 switched_off shape while off; switching on restores', async () => {
    const { switches, stored } = storedSwitches({ 'integration.google_drive': 'off' });
    await expect(requireIntegrationOn(switches, 'google_drive', 'c')).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      details: [{ field: 'integration', message: 'switched_off' }],
    });
    stored['integration.google_drive'] = 'on';
    switches.forget();
    await expect(requireIntegrationOn(switches, 'google_drive', 'c')).resolves.toBeUndefined();
    await expect(requireIntegrationOn(switches, 'figma', 'c')).resolves.toBeUndefined();
  });

  it('fails closed when the switch cannot be read', async () => {
    const switches = createIntegrationSwitchesFrom(async () => {
      throw new Error('db down');
    });
    await expect(requireIntegrationOn(switches, 'onedrive', 'c')).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('IntegrationSwitchGuard on the connect, completion and use routes', () => {
  const database = {
    identityRead: async (
      _options: unknown,
      work: (db: { query: () => Promise<unknown[]> }) => Promise<unknown>,
    ) => work({ query: async () => [{ setting_value: 'off' }] }),
  } as unknown as TenantDatabase;

  function contextFor(handler: object, owner: object, params: Record<string, string>) {
    const request = { headers: {}, params };
    ensureRequestState(request);
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => handler,
      getClass: () => owner,
    } as unknown as ExecutionContext;
  }

  it('carries the guard on connect, sign-in completion and use routes', () => {
    for (const handler of [
      GoogleDriveStorageController.prototype.connect,
      GoogleDriveStorageController.prototype.complete,
      GoogleDriveStorageController.prototype.projectFiles,
      FigmaController.prototype.start,
      AppConnectController.prototype.start,
      AppConnectController.prototype.complete,
    ]) {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(IntegrationSwitchGuard);
    }
    // Status reads and disconnects stay open: a switched-off service never hides or deletes data.
    expect(
      Reflect.getMetadata(GUARDS_METADATA, GoogleDriveStorageController.prototype.status) ?? [],
    ).not.toContain(IntegrationSwitchGuard);
  });

  it('refuses a switched-off service, by fixed key and by route parameter', async () => {
    forgetIntegrationSwitches();
    const guard = new IntegrationSwitchGuard(new Reflector(), database);
    await expect(
      guard.canActivate(
        contextFor(
          GoogleDriveStorageController.prototype.connect,
          GoogleDriveStorageController,
          {},
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      guard.canActivate(
        contextFor(AppConnectController.prototype.start, AppConnectController, {
          provider: 'github',
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    forgetIntegrationSwitches();
  });
});

describe('the settings routes stay behind the platform admin guard', () => {
  async function status(permissions: PlatformPermission[] | null, handler: object) {
    const lookup: PlatformAdminLookup = {
      findAccount: async () => ({
        userId: USER,
        email: 'owner@example.com',
        displayName: 'O',
        emailVerified: true,
        mfaEnabled: true,
      }),
      findLiveStepUp: async () => ({
        expiresAt: new Date(Date.now() + 600_000),
        mfaVerified: true,
      }),
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
      getHandler: () => handler,
      getClass: () => PlatformSettingsController,
    } as unknown as ExecutionContext;
    return guard.canActivate(context).then(
      () => 200,
      (error: { status: number }) => error.status,
    );
  }

  it('refuses a non-platform-admin and an admin without platform.settings.edit', async () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PlatformSettingsController)).toContain(
      PlatformAdminGuard,
    );
    const put = PlatformSettingsController.prototype.setIntegration;
    expect([
      await status(null, PlatformSettingsController.prototype.integrations),
      await status(null, put),
      await status(['platform.orgs.view'], put),
      await status(['platform.settings.edit'], put),
    ]).toEqual([404, 404, 403, 200]);
  });
});
