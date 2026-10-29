import type { Capability } from '@tmanage/domain';
import type { ApiClient } from './client';
import type { EffectivePermissions, MemberOverrideInput } from './permission-matrix';

/**
 * platform-admin v2 · PA-04 — the platform side of the permission editors (SPEC §5.2, D7/D8):
 * `/v1/platform/organizations/:organizationId/roles…` and
 * `/v1/platform/organizations/:organizationId/members/:membershipId/permissions…`.
 *
 * The shapes are paired Exact with the API in `e2e/contracts/api-web-shapes.ts`.
 */

export interface PlatformOrgRoleView {
  readonly id: string;
  readonly name: string;
  readonly kind: 'internal' | 'client';
  readonly builtIn: boolean;
  readonly capabilities: readonly Capability[];
  readonly holders: number;
  readonly createdAt: string | null;
}

export interface PlatformOrgRolesView {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly slug: string;
  readonly permissionCount: number;
  readonly roles: readonly PlatformOrgRoleView[];
}

export interface PlatformOrgRoleWriteView {
  readonly role: PlatformOrgRoleView;
}

export interface PlatformOrgRoleDeleteView {
  readonly deletedRoleId: string;
  readonly reassignedTo: string;
  readonly reassigned: number;
}

export interface PlatformMemberOverrideView {
  readonly id: string;
  readonly capability: Capability;
  readonly effect: 'allow' | 'deny';
  readonly reason: string | null;
  readonly expiresAt: string | null;
  readonly createdBy: string;
  readonly createdByName: string | null;
  readonly createdAt: string;
  readonly live: boolean;
}

export interface PlatformMemberPermissionsView {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly slug: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  readonly kind: 'internal' | 'client';
  readonly role: string;
  readonly roleName: string;
  readonly status: string;
  readonly scope: 'org' | 'workspace' | 'projects';
  readonly editable: boolean;
  readonly overrides: readonly PlatformMemberOverrideView[];
  readonly effective: EffectivePermissions;
  readonly projects: readonly { readonly id: string; readonly name: string }[];
}

function orgBase(organizationId: string): string {
  return `/v1/platform/organizations/${encodeURIComponent(organizationId)}`;
}

function roleBase(organizationId: string, roleId: string): string {
  return `${orgBase(organizationId)}/roles/${encodeURIComponent(roleId)}`;
}

function memberBase(organizationId: string, membershipId: string): string {
  return `${orgBase(organizationId)}/members/${encodeURIComponent(membershipId)}`;
}

export async function fetchPlatformOrgRoles(
  client: ApiClient,
  organizationId: string,
): Promise<PlatformOrgRolesView> {
  const { data } = await client.request<PlatformOrgRolesView>({
    path: `${orgBase(organizationId)}/roles`,
  });
  return data;
}

export async function createPlatformOrgRole(
  client: ApiClient,
  organizationId: string,
  input: { name: string; capabilities: readonly Capability[]; reason?: string },
): Promise<PlatformOrgRoleWriteView> {
  const { data } = await client.request<PlatformOrgRoleWriteView>({
    method: 'POST',
    path: `${orgBase(organizationId)}/roles`,
    body: input,
  });
  return data;
}

export async function updatePlatformOrgRole(
  client: ApiClient,
  organizationId: string,
  roleId: string,
  input: { name?: string; capabilities?: readonly Capability[]; reason?: string },
): Promise<PlatformOrgRoleWriteView> {
  const { data } = await client.request<PlatformOrgRoleWriteView>({
    method: 'PATCH',
    path: roleBase(organizationId, roleId),
    body: input,
  });
  return data;
}

export async function clonePlatformOrgRole(
  client: ApiClient,
  organizationId: string,
  roleId: string,
  input: { name: string; reason?: string },
): Promise<PlatformOrgRoleWriteView> {
  const { data } = await client.request<PlatformOrgRoleWriteView>({
    method: 'POST',
    path: `${roleBase(organizationId, roleId)}/clone`,
    body: input,
  });
  return data;
}

export async function deletePlatformOrgRole(
  client: ApiClient,
  organizationId: string,
  roleId: string,
  input: { reassignTo: string; reason?: string },
): Promise<PlatformOrgRoleDeleteView> {
  const { data } = await client.request<PlatformOrgRoleDeleteView>({
    method: 'DELETE',
    path: roleBase(organizationId, roleId),
    body: input,
  });
  return data;
}

export async function fetchPlatformMemberPermissions(
  client: ApiClient,
  organizationId: string,
  membershipId: string,
  projectId?: string,
): Promise<PlatformMemberPermissionsView> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const { data } = await client.request<PlatformMemberPermissionsView>({
    path: `${memberBase(organizationId, membershipId)}/permissions${query}`,
  });
  return data;
}

export async function replacePlatformMemberOverrides(
  client: ApiClient,
  organizationId: string,
  membershipId: string,
  overrides: readonly MemberOverrideInput[],
  reason?: string,
): Promise<PlatformMemberPermissionsView> {
  const { data } = await client.request<PlatformMemberPermissionsView>({
    method: 'PUT',
    path: `${memberBase(organizationId, membershipId)}/permissions/overrides`,
    body: { overrides, ...(reason ? { reason } : {}) },
  });
  return data;
}

export async function fetchPlatformEffectivePermissions(
  client: ApiClient,
  organizationId: string,
  membershipId: string,
  projectId?: string,
): Promise<EffectivePermissions> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const { data } = await client.request<EffectivePermissions>({
    path: `${memberBase(organizationId, membershipId)}/effective-permissions${query}`,
  });
  return data;
}
