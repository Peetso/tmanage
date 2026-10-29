import { PLATFORM_PERMISSION_AREAS, PLATFORM_PERMISSIONS } from '@tmanage/domain';
import type { PlatformPermission } from '@tmanage/domain';
import type { MessageKey } from '../../../lib/i18n/t';

/**
 * Labels for the 18 platform permissions (SPEC §3.1) as drawn: the short form in the add-admin
 * dialog's area boxes (436:19172) and the "Area · action" form in the presets matrix (439:18886).
 */

type AreaId = (typeof PLATFORM_PERMISSION_AREAS)[number]['id'];

export const AREA_LABELS: Record<AreaId, MessageKey> = {
  organizations: 'PlatformTeam.areaOrganizations',
  people: 'PlatformTeam.areaPeople',
  content: 'PlatformTeam.areaContent',
  activity: 'PlatformTeam.areaActivity',
  settings: 'PlatformTeam.areaSettings',
  team: 'PlatformTeam.areaTeam',
};

export const SHORT_LABELS: Record<PlatformPermission, MessageKey> = {
  'platform.orgs.view': 'PlatformTeam.permOrgsView',
  'platform.orgs.edit': 'PlatformTeam.permOrgsEdit',
  'platform.orgs.lifecycle': 'PlatformTeam.permOrgsLifecycle',
  'platform.orgs.enter': 'PlatformTeam.permOrgsEnter',
  'platform.people.view': 'PlatformTeam.permPeopleView',
  'platform.people.edit': 'PlatformTeam.permPeopleEdit',
  'platform.people.security': 'PlatformTeam.permPeopleSecurity',
  'platform.people.roles': 'PlatformTeam.permPeopleRoles',
  'platform.content.view': 'PlatformTeam.permContentView',
  'platform.content.moderate': 'PlatformTeam.permContentModerate',
  'platform.activity.view': 'PlatformTeam.permActivityView',
  'platform.activity.detail': 'PlatformTeam.permActivityDetail',
  'platform.activity.export': 'PlatformTeam.permActivityExport',
  'platform.settings.edit': 'PlatformTeam.permSettingsEdit',
  'platform.flags.edit': 'PlatformTeam.permFlagsEdit',
  'platform.announcements.edit': 'PlatformTeam.permAnnouncementsEdit',
  'platform.permissions.edit': 'PlatformTeam.permPermissionsEdit',
  'platform.team.manage': 'PlatformTeam.permTeamManage',
};

export const MATRIX_LABELS: Record<PlatformPermission, MessageKey> = {
  'platform.orgs.view': 'PlatformTeam.matrixOrgsView',
  'platform.orgs.edit': 'PlatformTeam.matrixOrgsEdit',
  'platform.orgs.lifecycle': 'PlatformTeam.matrixOrgsLifecycle',
  'platform.orgs.enter': 'PlatformTeam.matrixOrgsEnter',
  'platform.people.view': 'PlatformTeam.matrixPeopleView',
  'platform.people.edit': 'PlatformTeam.matrixPeopleEdit',
  'platform.people.security': 'PlatformTeam.matrixPeopleSecurity',
  'platform.people.roles': 'PlatformTeam.matrixPeopleRoles',
  'platform.content.view': 'PlatformTeam.matrixContentView',
  'platform.content.moderate': 'PlatformTeam.matrixContentModerate',
  'platform.activity.view': 'PlatformTeam.matrixActivityView',
  'platform.activity.detail': 'PlatformTeam.matrixActivityDetail',
  'platform.activity.export': 'PlatformTeam.matrixActivityExport',
  'platform.settings.edit': 'PlatformTeam.matrixSettingsEdit',
  'platform.flags.edit': 'PlatformTeam.matrixFlagsEdit',
  'platform.announcements.edit': 'PlatformTeam.matrixAnnouncementsEdit',
  'platform.permissions.edit': 'PlatformTeam.matrixPermissionsEdit',
  'platform.team.manage': 'PlatformTeam.matrixTeamManage',
};

export { PLATFORM_PERMISSION_AREAS, PLATFORM_PERMISSIONS };
export type { PlatformPermission };
