import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { apiErrorBody } from '../../common/http/errors.js';
import { PlatformActivityController } from './activity/activity.controller.js';
import { PlatformOrganizationsController } from './organizations/organizations.controller.js';
import { PlatformPeopleController } from './people/people.controller.js';
import { platformPermissionMissing } from './platform-admin.guard.js';
import { PlatformAdminController } from './platform-admin.controller.js';
import {
  PLATFORM_PERMISSION_METADATA,
  RequirePlatformPermission,
} from './require-platform-permission.decorator.js';
import { PlatformSettingsController } from './settings/settings.controller.js';
import { PlatformTeamController } from './team/team.controller.js';

/** Every platform route names its permission; a missing one is a 403 that says which. */

function required(controller: { prototype: object }, method: string): unknown {
  const handler = (controller.prototype as Record<string, unknown>)[method] as () => void;
  return new Reflector().get(PLATFORM_PERMISSION_METADATA, handler);
}

describe('@RequirePlatformPermission', () => {
  it('stores the key on the handler', () => {
    class Probe {
      @RequirePlatformPermission('platform.flags.edit')
      handle(): void {}
    }
    expect(required(Probe, 'handle')).toBe('platform.flags.edit');
  });

  it('is on every moved route, with the permission the plan names', () => {
    expect({
      overview: required(PlatformOrganizationsController, 'overview'),
      companies: required(PlatformOrganizationsController, 'companies'),
      company: required(PlatformOrganizationsController, 'company'),
      suspend: required(PlatformOrganizationsController, 'suspend'),
      reactivate: required(PlatformOrganizationsController, 'reactivate'),
      people: required(PlatformPeopleController, 'people'),
      signOut: required(PlatformPeopleController, 'signOut'),
      passwordReset: required(PlatformPeopleController, 'passwordReset'),
      settings: required(PlatformSettingsController, 'settings'),
      publicSignup: required(PlatformSettingsController, 'setPublicSignup'),
      aiAccess: required(PlatformSettingsController, 'setAiAccess'),
      audit: required(PlatformActivityController, 'audit'),
      team: required(PlatformTeamController, 'list'),
      teamAdd: required(PlatformTeamController, 'add'),
      teamUpdate: required(PlatformTeamController, 'update'),
      teamRemove: required(PlatformTeamController, 'remove'),
      presets: required(PlatformTeamController, 'presets'),
      writePreset: required(PlatformTeamController, 'writePreset'),
    }).toEqual({
      overview: 'platform.orgs.view',
      companies: 'platform.orgs.view',
      company: 'platform.orgs.view',
      suspend: 'platform.orgs.lifecycle',
      reactivate: 'platform.orgs.lifecycle',
      people: 'platform.people.view',
      signOut: 'platform.people.security',
      passwordReset: 'platform.people.security',
      settings: 'platform.settings.edit',
      publicSignup: 'platform.settings.edit',
      aiAccess: 'platform.settings.edit',
      audit: 'platform.activity.view',
      team: 'platform.team.manage',
      teamAdd: 'platform.team.manage',
      teamUpdate: 'platform.team.manage',
      teamRemove: 'platform.team.manage',
      presets: 'platform.team.manage',
      writePreset: 'platform.team.manage',
    });
    // `me` and `step-up` need no permission beyond being a platform admin.
    expect(required(PlatformAdminController, 'me')).toBeUndefined();
    expect(required(PlatformAdminController, 'stepUp')).toBeUndefined();
  });

  it('refuses with 403 platform_permission_missing naming the key', () => {
    const error = platformPermissionMissing('platform.settings.edit');
    expect(error.status).toBe(403);
    expect(apiErrorBody(error, 'corr')).toEqual({
      error: {
        code: 'platform_permission_missing',
        message: "Your platform permissions don't include this.",
        correlationId: 'corr',
        details: [{ field: 'permission', message: 'platform.settings.edit' }],
      },
    });
  });
});
