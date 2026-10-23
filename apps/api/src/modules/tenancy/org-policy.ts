import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { isSettingOn } from './org-settings.allowlist.js';
import type { OrgBooleanSettingKey } from './org-settings.allowlist.js';
import { OrgSettingsRepository } from './org-settings.repository.js';

/**
 * A11 — the "What members can do" switches, read by the routes they govern.
 *
 * Each switch only narrows what the capability ceiling already allows (`25-AUTHORIZATION` §4: policy
 * "may narrow, never silently widen"). A route asks {@link requireOrgPermission} after its own
 * capability check; when the switch is on (the default) nothing changes, and when it is off only the
 * roles named for that switch pass.
 */

/** The organization's administrators — never narrowed by a members switch. */
const ADMIN_ROLES: readonly string[] = ['owner', 'org_admin', 'workspace_admin'];

/** "Admins and project leads" — who may still invite clients when members may not. */
const ADMIN_AND_LEAD_ROLES: readonly string[] = [...ADMIN_ROLES, 'manager'];

/** Which principals a switch that is OFF still lets through. */
const STILL_ALLOWED: Readonly<
  Record<Exclude<OrgBooleanSettingKey, 'require_two_step'>, (principal: Principal) => boolean>
> = {
  members_can_create_projects: (principal) =>
    principal.kind === 'internal' && ADMIN_ROLES.includes(principal.role),
  members_can_invite_clients: (principal) =>
    principal.kind === 'internal' && ADMIN_AND_LEAD_ROLES.includes(principal.role),
  clients_can_upload_files: (principal) => principal.kind !== 'client',
};

/** Whether the switch is on for the acting organization. A missing row reads as the default. */
export async function readOrgSwitch(
  database: TenantDatabase,
  context: TenantContext,
  key: OrgBooleanSettingKey,
  repository: OrgSettingsRepository = new OrgSettingsRepository(),
): Promise<boolean> {
  const row = await database.read(context, (runner) => repository.findByKey(runner, context, key));
  return isSettingOn(key, row?.settingValue);
}

/**
 * Refuse with 403 when the switch is off and this principal is not one it still allows. A route
 * built without the database (a unit test constructing the controller directly) skips the read and
 * keeps the default behaviour.
 */
export async function requireOrgPermission(
  database: TenantDatabase | undefined,
  context: TenantContext,
  principal: Principal,
  key: Exclude<OrgBooleanSettingKey, 'require_two_step'>,
  repository?: OrgSettingsRepository,
): Promise<void> {
  if (!database) return;
  if (STILL_ALLOWED[key](principal)) return;
  if (await readOrgSwitch(database, context, key, repository)) return;
  throw new ApiError(
    403,
    'forbidden',
    'Your organization has turned this off. Ask an admin.',
    undefined,
    `org_policy:${key}`,
  );
}
