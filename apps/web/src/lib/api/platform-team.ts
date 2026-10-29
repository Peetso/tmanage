import type { ApiClient } from './client';

/**
 * Platform admin · Team (`/v1/platform/team…`, SPEC §5.1). Every route needs
 * `platform.team.manage` (the super admin preset); a missing permission answers 403
 * `platform_permission_missing`. Every write needs a reason (5–500 characters).
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API views in
 * `e2e/contracts/api-web-shapes.ts`.
 */

export type PlatformPresetName = 'super_admin' | 'support' | 'auditor' | 'custom';

export interface PlatformTeamMemberView {
  /** The team row id, or `null` for a server-list admin without one. */
  readonly id: string | null;
  readonly userId: string | null;
  readonly email: string;
  readonly displayName: string | null;
  readonly source: 'env' | 'db';
  readonly preset: PlatformPresetName;
  readonly permissions: readonly string[];
  readonly status: 'active' | 'disabled';
  readonly locked: boolean;
  readonly self: boolean;
  readonly addedByEmail: string | null;
  readonly createdAt: string | null;
  readonly disabledAt: string | null;
  readonly disabledReason: string | null;
  readonly lastStepUpAt: string | null;
}

export interface PlatformTeamView {
  readonly admins: readonly PlatformTeamMemberView[];
  readonly permissionCount: number;
  readonly superAdmins: number;
  readonly envSuperAdmins: number;
  readonly canManage: boolean;
}

export interface PlatformPresetView {
  readonly preset: PlatformPresetName;
  readonly permissions: readonly string[];
  readonly defaults: readonly string[];
  readonly editable: boolean;
  readonly adminCount: number;
}

export interface PlatformPresetsView {
  readonly presets: readonly PlatformPresetView[];
  readonly allPermissions: readonly string[];
  readonly canManage: boolean;
}

export interface PlatformTeamWriteView {
  readonly admin: PlatformTeamMemberView;
}

export async function fetchPlatformTeam(client: ApiClient): Promise<PlatformTeamView> {
  const { data } = await client.request<PlatformTeamView>({ path: '/v1/platform/team' });
  return data;
}

export async function addPlatformAdmin(
  client: ApiClient,
  input: {
    readonly email: string;
    readonly preset: PlatformPresetName;
    readonly permissions?: readonly string[];
    readonly reason: string;
  },
): Promise<PlatformTeamWriteView> {
  const { data } = await client.request<PlatformTeamWriteView>({
    method: 'POST',
    path: '/v1/platform/team',
    body: input,
  });
  return data;
}

export async function updatePlatformAdmin(
  client: ApiClient,
  adminId: string,
  input: {
    readonly preset?: PlatformPresetName;
    readonly permissions?: readonly string[];
    readonly status?: 'active' | 'disabled';
    readonly reason: string;
  },
): Promise<PlatformTeamWriteView> {
  const { data } = await client.request<PlatformTeamWriteView>({
    method: 'PATCH',
    path: `/v1/platform/team/${encodeURIComponent(adminId)}`,
    body: input,
  });
  return data;
}

export async function removePlatformAdmin(
  client: ApiClient,
  adminId: string,
  reason: string,
): Promise<PlatformTeamWriteView> {
  const { data } = await client.request<PlatformTeamWriteView>({
    method: 'DELETE',
    path: `/v1/platform/team/${encodeURIComponent(adminId)}`,
    body: { reason },
  });
  return data;
}

export async function fetchPlatformPresets(client: ApiClient): Promise<PlatformPresetsView> {
  const { data } = await client.request<PlatformPresetsView>({
    path: '/v1/platform/team/presets',
  });
  return data;
}

export async function savePlatformPreset(
  client: ApiClient,
  preset: 'support' | 'auditor',
  permissions: readonly string[],
  reason: string,
): Promise<PlatformPresetsView> {
  const { data } = await client.request<PlatformPresetsView>({
    method: 'PUT',
    path: `/v1/platform/team/presets/${preset}`,
    body: { permissions, reason },
  });
  return data;
}
