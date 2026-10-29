import type { DynamicModule } from '@nestjs/common';
import { PlatformActivityModule } from './activity/activity.module.js';
import { PlatformOrganizationsModule } from './organizations/organizations.module.js';
import { PlatformPeopleModule } from './people/people.module.js';
import { PlatformSettingsModule } from './settings/settings.module.js';
import { PlatformTeamModule } from './team/team.module.js';
// ---- platform-admin v2 · PA-04 ----
import { PlatformPermissionsModule } from './permissions/permissions.module.js';
// ---- platform-admin v2 · PA-05 ----
import { PlatformSupportModule } from './support/support.module.js';

/**
 * Every Platform admin area, one Nest module each (platform-admin v2, PA-02 split). Each area
 * imports `platformAdminCore()` for the guard, the lookup, the audit writer and the team table.
 *
 * Append-only: a slice that adds an area appends its `register()` call at the end, under its
 * marker comment.
 */
export const PLATFORM_AREA_MODULES: DynamicModule[] = [
  // ---- platform-admin v2 · PA-02 ----
  PlatformOrganizationsModule.register(),
  PlatformPeopleModule.register(),
  PlatformSettingsModule.register(),
  PlatformActivityModule.register(),
  PlatformTeamModule.register(),
  // ---- platform-admin v2 · PA-04 ----
  PlatformPermissionsModule.register(),
  // ---- platform-admin v2 · PA-05 ----
  PlatformSupportModule.register(),
];
